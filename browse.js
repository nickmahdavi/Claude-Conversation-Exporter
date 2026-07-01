// State management
let allConversations = [];
let filteredConversations = [];
let orgId = null;
let currentSort = 'updated_desc';

// Maps project uuid -> project name, populated from the /projects endpoint.
let projectMap = {};
// UUIDs of conversations currently open in tabs in THIS Chrome window.
// Populated on demand via chrome.tabs.query (see refreshOpenTabs).
let openTabUuids = new Set();
// The exact phrase the user must type to confirm a delete, e.g. "DELETE 42".
// Set per-open in openDeleteModal so it reflects the current count.
let deleteConfirmPhrase = 'DELETE';

// --- Conversation list caching (stale-while-revalidate) ---
// Bump CACHE_VERSION whenever the cached object shape changes, to invalidate
// stale caches from older builds.
const CACHE_VERSION = 1;
// How long a cache is considered "fresh": within this window we skip the
// network entirely on open. Past it, we still render from cache instantly but
// refresh in the background. Tune to taste.
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes
let lastCachedAt = null;        // ms timestamp the current data was fetched
let currentSignature = null;    // cheap fingerprint to detect "nothing changed"

function cacheKey() {
  return `convCache:${orgId}`;
}

// Cheap fingerprint of a conversation list: count + newest updated_at.
// ISO timestamps sort lexicographically, so string max is fine.
function signatureOf(list) {
  let max = '';
  for (const c of list) {
    if (c.updated_at && c.updated_at > max) max = c.updated_at;
  }
  return `${list.length}:${max}`;
}

// Human-friendly relative time, e.g. "just now", "3m ago", "2h ago".
function relativeTime(ts) {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Update the little "· updated 3m ago" / "· refreshing…" hint in the stats bar.
function updateCacheStatus(state) {
  const el = document.getElementById('cacheAge');
  if (!el) return;
  if (state === 'refreshing') {
    el.textContent = ' · refreshing…';
  } else if (lastCachedAt) {
    el.textContent = ` · updated ${relativeTime(lastCachedAt)}`;
  } else {
    el.textContent = '';
  }
}

// Read cached conversations for this org and render immediately.
// Returns true if a usable cache was found and rendered.
function loadFromCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([cacheKey()], (res) => {
      const cached = res[cacheKey()];
      if (!cached || cached.v !== CACHE_VERSION || !Array.isArray(cached.conversations)) {
        resolve(false);
        return;
      }
      projectMap = cached.projectMap || {};
      allConversations = cached.conversations;
      lastCachedAt = cached.cachedAt || null;
      currentSignature = signatureOf(allConversations);
      rebuildFilters();
      applyFiltersAndSort();
      updateCacheStatus();
      resolve(true);
    });
  });
}

// Persist the current resolved conversations + project map for this org.
function saveToCache() {
  lastCachedAt = Date.now();
  const payload = {
    v: CACHE_VERSION,
    cachedAt: lastCachedAt,
    projectMap,
    conversations: allConversations,
  };
  chrome.storage.local.set({ [cacheKey()]: payload }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Failed to write conversation cache:', chrome.runtime.lastError);
    }
  });
}

// --- Row selection (toggle-click accumulative; shift-range; drag adds range) ---
let selectedUuids = new Set();        // selected conversation uuids
let selectionAnchorIndex = null;      // anchor row index for shift-click ranges
let isPointerDown = false;            // left button held over a row
let pointerAnchorIndex = null;        // row index where the press started
let dragMoved = false;                // pointer moved to another row → it's a drag
let dragLastIndex = null;             // last row the drag reached (dedupe)
let preDragSelection = null;          // selection snapshot to add the drag range onto
let uuidToRow = new Map();            // uuid -> <tr> for cheap highlight updates
let highlightedUuids = new Set();     // uuids currently shown highlighted in the DOM
// Opening more than this many tabs at once asks for confirmation first.
const OPEN_TABS_CONFIRM_THRESHOLD = 15;

// Conversations that are both selected AND currently visible (post-filter).
function getSelectedVisible() {
  return filteredConversations.filter(c => selectedUuids.has(c.uuid));
}

// Targets for bulk actions: the selection if any is visible, else the whole
// filtered list (preserves the original "acts on what you see" behavior).
function getActionTargets() {
  const selected = getSelectedVisible();
  return selected.length ? selected : filteredConversations;
}

// Select the inclusive index range [from..to] in the current filtered order.
// additive=false clears any prior selection first (shift / drag); true keeps it.
function selectRange(from, to, additive) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (!additive) selectedUuids.clear();
  for (let i = lo; i <= hi; i++) {
    const conv = filteredConversations[i];
    if (conv) selectedUuids.add(conv.uuid);
  }
}

// Flip one row's selected state.
function toggleRow(index) {
  const uuid = filteredConversations[index]?.uuid;
  if (!uuid) return;
  if (selectedUuids.has(uuid)) selectedUuids.delete(uuid);
  else selectedUuids.add(uuid);
}

// Push the current selection to the DOM by toggling only the rows that changed,
// so dragging across a 7k-row table stays cheap.
function applySelection() {
  for (const uuid of selectedUuids) {
    if (!highlightedUuids.has(uuid)) uuidToRow.get(uuid)?.classList.add('selected');
  }
  for (const uuid of highlightedUuids) {
    if (!selectedUuids.has(uuid)) uuidToRow.get(uuid)?.classList.remove('selected');
  }
  highlightedUuids = new Set(selectedUuids);
  updateSelectionBar();
}

function clearSelection() {
  selectedUuids.clear();
  selectionAnchorIndex = null;
  applySelection();
}

// Show/hide the floating selection bar and keep the bulk-button labels in sync.
function updateSelectionBar() {
  const count = getSelectedVisible().length;
  const bar = document.getElementById('selectionBar');
  if (bar) {
    document.getElementById('selectionCount').textContent =
      `${count} selected`;
    bar.classList.toggle('show', count > 0);
  }
  const exportBtn = document.getElementById('exportAllBtn');
  const deleteBtn = document.getElementById('deleteAllBtn');
  if (exportBtn) exportBtn.textContent = count ? `Export Selected (${count})` : 'Export All';
  if (deleteBtn) deleteBtn.textContent = count ? `Delete Selected (${count})` : 'Delete Filtered';
}

// Open every selected conversation in the lightweight plaintext viewer, as
// background tabs in this window (so they don't steal focus and the
// "open in this window" filter can see them).
function openSelectedAsText() {
  const targets = getSelectedVisible();
  if (!targets.length) return;
  if (targets.length > OPEN_TABS_CONFIRM_THRESHOLD &&
      !confirm(`Open ${targets.length} plaintext tabs in this window?`)) {
    return;
  }
  targets.forEach(conv => {
    chrome.tabs.create({ url: chrome.runtime.getURL('view.html?id=' + conv.uuid), active: false });
  });
  showToast(`Opened ${targets.length} tab${targets.length === 1 ? '' : 's'}`);
}

// Model name mappings
const MODEL_DISPLAY_NAMES = {
  'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
  'claude-3-opus-20240229': 'Claude 3 Opus',
  'claude-3-haiku-20240307': 'Claude 3 Haiku',
  'claude-3-5-sonnet-20240620': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
  'claude-3-5-sonnet-20241022': 'Claude 3.6 Sonnet',
  'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-opus-4-20250514': 'Claude Opus 4',
  'claude-opus-4-1-20250805': 'Claude Opus 4.1',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-opus-4-5-20251101': 'Claude Opus 4.5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-6': 'Claude Opus 4.6'
};

// inferModel() + DEFAULT_MODEL_TIMELINE now live in utils.js (shared with view.js).

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  await loadOrgId();
  setupEventListeners();
  await refreshOpenTabs();
  if (!orgId) return;

  // Stale-while-revalidate: render instantly from cache, then refresh only if stale.
  const hadCache = await loadFromCache();
  if (hadCache) {
    const age = lastCachedAt ? Date.now() - lastCachedAt : Infinity;
    if (age > STALE_AFTER_MS) revalidate(false); // background refresh, no await
  } else {
    await revalidate(true); // first-ever load: blocking, shows the spinner
  }
});

// Load organization ID from storage
async function loadOrgId() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['organizationId'], (result) => {
      orgId = result.organizationId;
      if (!orgId) {
        showError('Organization ID not configured. Please configure it in the extension options.');
      }
      resolve();
    });
  });
}

// Load the org's projects so we can show/filter by project name.
// Non-fatal: if it fails we just won't have project names.
async function loadProjects() {
  if (!orgId) return;

  try {
    const response = await fetch(`https://claude.ai/api/organizations/${orgId}/projects`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const projects = await response.json();
    projectMap = {};
    projects.forEach(p => {
      if (p && p.uuid) projectMap[p.uuid] = p.name || '(untitled project)';
    });
    console.log(`Loaded ${Object.keys(projectMap).length} projects`);
  } catch (error) {
    console.warn('Could not load projects (project names/filter may be unavailable):', error);
  }
}

// Read a conversation's project UUID defensively — the list payload may expose
// it as project_uuid or as a nested project object depending on API version.
function getProjectUuid(conv) {
  return conv.project_uuid || (conv.project && conv.project.uuid) || null;
}

// Re-scan tabs in the CURRENT Chrome window and collect the conversation UUIDs
// of any open claude.ai/chat/<uuid> pages. Used by the "open in this window" filter.
async function refreshOpenTabs() {
  openTabUuids = new Set();
  if (!chrome.tabs || !chrome.tabs.query) return;

  // Pull a uuid out of either a live chat URL or our viewer URL; null otherwise.
  const uuidFromUrl = (url) => {
    if (!url) return null;
    const chat = url.match(/claude\.ai\/chat\/([0-9a-f-]{8,})/i);
    if (chat) return chat[1];
    if (url.includes('view.html')) {
      try { return new URL(url).searchParams.get('id'); } catch (_) { return null; }
    }
    return null;
  };

  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tabs.forEach(tab => {
      // pendingUrl covers tabs that are still loading when we scan.
      const id = uuidFromUrl(tab.url || tab.pendingUrl);
      if (id) openTabUuids.add(id);
    });
    console.log(`Found ${openTabUuids.size} open chat tab(s) in this window`);
  } catch (error) {
    console.warn('Could not read open tabs:', error);
  }
}

// Populate the project filter dropdown from projects that actually appear
// on at least one conversation (keeps the list tidy).
function populateProjectFilter() {
  const select = document.getElementById('projectFilter');
  const usedProjectUuids = new Set(
    allConversations.map(getProjectUuid).filter(Boolean)
  );

  // Preserve the current selection across re-population if still valid.
  const previous = select.value;

  const entries = [...usedProjectUuids]
    .map(uuid => ({ uuid, name: projectMap[uuid] || '(unknown project)' }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  select.innerHTML =
    '<option value="">All Projects</option>' +
    '<option value="__none__">No project</option>' +
    '<option value="__any__">Any project</option>' +
    entries.map(e => `<option value="${e.uuid}">${e.name}</option>`).join('');

  // Restore previous selection if the option still exists.
  if ([...select.options].some(o => o.value === previous)) {
    select.value = previous;
  }
}

// Fetch the raw conversation list from the API (throws on failure).
async function fetchConversationList() {
  const response = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Failed to load conversations: ${response.status}`);
  }
  return response.json();
}

// Resolve raw list items into the shape the UI uses: infer model, attach project.
function resolveConversations(raw) {
  return raw.map(conv => {
    const projectUuid = getProjectUuid(conv);
    return {
      ...conv,
      model: inferModel(conv),
      projectUuid,
      projectName: projectUuid ? (projectMap[projectUuid] || '(unknown project)') : null
    };
  });
}

// Rebuild the model + project filter dropdowns from current data.
function rebuildFilters() {
  const models = [...new Set(allConversations.map(c => c.model))].filter(m => m).sort();
  populateModelFilter(models);
  populateProjectFilter();
}

// Fetch fresh projects + conversations, update state/cache, and re-render if changed.
// isInitial=true means there was no cache to show first, so we always render and
// surface errors loudly; otherwise this is a quiet background refresh.
async function revalidate(isInitial = false) {
  if (!orgId) return;
  try {
    if (!isInitial) updateCacheStatus('refreshing');
    await loadProjects();
    const raw = await fetchConversationList();
    const resolved = resolveConversations(raw);
    const sig = signatureOf(resolved);

    // Only touch the DOM when something actually changed — avoids flicker/scroll
    // jumps on the common "nothing new" background refresh.
    if (isInitial || sig !== currentSignature) {
      allConversations = resolved;
      currentSignature = sig;
      rebuildFilters();
      applyFiltersAndSort();
    }
    saveToCache();
    updateCacheStatus();
    console.log(`Revalidated: ${resolved.length} conversations`);
  } catch (error) {
    console.error('Error loading conversations:', error);
    if (isInitial) {
      showError(`Failed to load conversations: ${error.message}`);
    } else {
      showToast(`Refresh failed: ${error.message}`, true);
      updateCacheStatus();
    }
  }
}

// Populate model filter dropdown
function populateModelFilter(models) {
  const modelFilter = document.getElementById('modelFilter');
  const previous = modelFilter.value;
  modelFilter.innerHTML = '<option value="">All Models</option>';

  models.forEach(model => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = formatModelName(model);
    modelFilter.appendChild(option);
  });

  // Preserve the user's selection across re-population (background refreshes).
  if ([...modelFilter.options].some(o => o.value === previous)) {
    modelFilter.value = previous;
  }
}

// Format model name for display
function formatModelName(model) {
  return MODEL_DISPLAY_NAMES[model] || model;
}

// Minimal HTML escaping for values interpolated into table markup.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Get model badge class
function getModelBadgeClass(model) {
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return '';
}

// Validate the two date ranges (start must be on or before end).
// Marks offending inputs with an .invalid class, shows a toast once,
// and returns which ranges are valid so the filter can ignore bad ones.
let lastDateWarning = 0;
function validateDateRanges() {
  const ranges = [
    { from: 'dateFrom', to: 'dateTo', label: 'Created' },
    { from: 'updatedFrom', to: 'updatedTo', label: 'Edited' },
  ];

  const result = {};
  ranges.forEach(({ from, to, label }) => {
    const fromEl = document.getElementById(from);
    const toEl = document.getElementById(to);
    const isValid = !(fromEl.value && toEl.value && fromEl.value > toEl.value);

    fromEl.classList.toggle('invalid', !isValid);
    toEl.classList.toggle('invalid', !isValid);

    if (!isValid && Date.now() - lastDateWarning > 1500) {
      showToast(`${label} "from" date must be on or before the "to" date`, true);
      lastDateWarning = Date.now();
    }

    // Key results by the range purpose: created / updated
    result[label === 'Created' ? 'created' : 'updated'] = isValid;
  });

  return result;
}

// Keep the native date pickers in sync so invalid ranges are hard to pick:
// the "to" picker can't go before "from", and vice versa.
function syncDateConstraints() {
  const pairs = [['dateFrom', 'dateTo'], ['updatedFrom', 'updatedTo']];
  pairs.forEach(([from, to]) => {
    const fromEl = document.getElementById(from);
    const toEl = document.getElementById(to);
    toEl.min = fromEl.value || '';
    fromEl.max = toEl.value || '';
  });
}

// Apply filters and sorting
function applyFiltersAndSort() {
  const searchTerm = document.getElementById('searchInput').value.toLowerCase();
  const modelFilter = document.getElementById('modelFilter').value;
  const projectFilter = document.getElementById('projectFilter').value;
  const openTabsOnly = document.getElementById('openTabsOnly').checked;

  // Validate date ranges first; invalid (start > end) ranges are ignored
  // so the list never silently shows wrong/empty results.
  const valid = validateDateRanges();

  // Build date boundaries (local time) from the YYYY-MM-DD inputs.
  // Start = 00:00:00 of the "from" day, end = 23:59:59.999 of the "to" day.
  const toBounds = (fromId, toId, isValid) => {
    if (!isValid) return { from: null, to: null };
    const fromVal = document.getElementById(fromId).value;
    const toVal = document.getElementById(toId).value;
    return {
      from: fromVal ? new Date(`${fromVal}T00:00:00`).getTime() : null,
      to: toVal ? new Date(`${toVal}T23:59:59.999`).getTime() : null,
    };
  };

  const created = toBounds('dateFrom', 'dateTo', valid.created);
  const updated = toBounds('updatedFrom', 'updatedTo', valid.updated);

  const inRange = (time, bounds) =>
    (bounds.from === null || time >= bounds.from) &&
    (bounds.to === null || time <= bounds.to);

  // Filter conversations
  filteredConversations = allConversations.filter(conv => {
    const matchesSearch = !searchTerm ||
      conv.name.toLowerCase().includes(searchTerm) ||
      (conv.summary && conv.summary.toLowerCase().includes(searchTerm));

    const matchesModel = !modelFilter || conv.model === modelFilter;

    // Project filter: "" = all, __none__ = no project, __any__ = has a project,
    // otherwise match a specific project UUID.
    let matchesProject = true;
    if (projectFilter === '__none__') {
      matchesProject = !conv.projectUuid;
    } else if (projectFilter === '__any__') {
      matchesProject = !!conv.projectUuid;
    } else if (projectFilter) {
      matchesProject = conv.projectUuid === projectFilter;
    }

    // Only chats open in a tab in this window (snapshot from refreshOpenTabs).
    const matchesOpenTab = !openTabsOnly || openTabUuids.has(conv.uuid);

    const matchesCreated = inRange(new Date(conv.created_at).getTime(), created);
    const matchesUpdated = inRange(new Date(conv.updated_at).getTime(), updated);

    return matchesSearch && matchesModel && matchesProject &&
           matchesOpenTab && matchesCreated && matchesUpdated;
  });
  
  // Sort conversations
  sortConversations();
  
  // Update display
  displayConversations();
  updateStats();
}

// Sort conversations based on current sort setting
function sortConversations() {
  const [field, direction] = currentSort.split('_');
  
  filteredConversations.sort((a, b) => {
    let aVal, bVal;
    
    switch (field) {
      case 'name':
        aVal = a.name.toLowerCase();
        bVal = b.name.toLowerCase();
        break;
      case 'created':
        aVal = new Date(a.created_at);
        bVal = new Date(b.created_at);
        break;
      case 'updated':
        aVal = new Date(a.updated_at);
        bVal = new Date(b.updated_at);
        break;
      default:
        return 0;
    }
    
    if (direction === 'asc') {
      return aVal > bVal ? 1 : -1;
    } else {
      return aVal < bVal ? 1 : -1;
    }
  });
}

// Display conversations in table
function displayConversations() {
  const tableContent = document.getElementById('tableContent');
  
  if (filteredConversations.length === 0) {
    tableContent.innerHTML = '<div class="no-results">No conversations found</div>';
    document.getElementById('exportAllBtn').disabled = true;
    document.getElementById('deleteAllBtn').disabled = true;
    uuidToRow = new Map();
    highlightedUuids = new Set();
    updateSelectionBar(); // nothing visible → bar hides, labels reset
    return;
  }
  
  let html = `
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="name">Name</th>
          <th class="sortable" data-sort="updated">Last Updated</th>
          <th class="sortable" data-sort="created">Created</th>
          <th>Model</th>
          <th>Project</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
  `;
  
  filteredConversations.forEach((conv, i) => {
    const updatedDate = new Date(conv.updated_at).toLocaleDateString();
    const createdDate = new Date(conv.created_at).toLocaleDateString();
    const modelBadgeClass = getModelBadgeClass(conv.model);
    const selectedClass = selectedUuids.has(conv.uuid) ? ' selected' : '';

    html += `
      <tr class="conv-row${selectedClass}" data-id="${conv.uuid}" data-index="${i}">
        <td>
          <div class="conversation-name">
            <a href="https://claude.ai/chat/${conv.uuid}" target="_blank" title="${conv.name}">
              ${conv.name}
            </a>
          </div>
        </td>
        <td class="date">${updatedDate}</td>
        <td class="date">${createdDate}</td>
        <td>
          <span class="model-badge ${modelBadgeClass}">
            ${formatModelName(conv.model)}
          </span>
        </td>
        <td>
          ${conv.projectName
            ? `<span class="project-badge" title="${escapeHtml(conv.projectName)}">${escapeHtml(conv.projectName)}</span>`
            : `<span class="project-badge none">—</span>`}
        </td>
        <td>
          <div class="actions">
            <button class="btn-small btn-export" data-id="${conv.uuid}" data-name="${conv.name}">
              Export
            </button>
            <a class="btn-small btn-text" href="${chrome.runtime.getURL('view.html?id=' + conv.uuid)}" target="_blank" rel="noopener" title="View as plain text (Markdown export format)">
              Text
            </a>
            <a class="btn-small btn-view" href="https://claude.ai/chat/${conv.uuid}" target="_blank" rel="noopener">
              View
            </a>
          </div>
        </td>
      </tr>
    `;
  });
  
  html += `
      </tbody>
    </table>
  `;
  
  tableContent.innerHTML = html;

  // Rebuild the uuid -> row map for selection highlighting, and re-apply the
  // current selection to the freshly rendered rows. The drag/shift anchor is
  // reset because row indices only mean something within one render.
  uuidToRow = new Map();
  highlightedUuids = new Set();
  tableContent.querySelectorAll('tr[data-id]').forEach(row => {
    uuidToRow.set(row.dataset.id, row);
    if (selectedUuids.has(row.dataset.id)) highlightedUuids.add(row.dataset.id);
  });
  selectionAnchorIndex = null;
  updateSelectionBar();

  // Add export button listeners
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', (e) => {
      exportConversation(e.target.dataset.id, e.target.dataset.name);
    });
  });

  // Text + View are now real <a> links (see displayConversations markup), so the
  // browser handles normal-click (new tab), cmd/ctrl-click and middle-click
  // (new background tab) natively — no JS listeners needed. Row selection is
  // handled by delegated listeners attached once in setupEventListeners.

  // Enable bulk-action buttons now that there are results
  document.getElementById('exportAllBtn').disabled = false;
  document.getElementById('deleteAllBtn').disabled = false;
}

// Update statistics
function updateStats() {
  const stats = document.getElementById('statsCount');
  stats.textContent = `Showing ${filteredConversations.length} of ${allConversations.length} conversations`;
  updateCacheStatus();
}

// Export single conversation
async function exportConversation(conversationId, conversationName) {
  const format = document.getElementById('exportFormat').value;
  const includeMetadata = document.getElementById('includeMetadata').checked;
  
  try {
    showToast(`Exporting ${conversationName}...`);
    
    const response = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
      {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch conversation: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Infer model if null
    data.model = inferModel(data);
    
    let content, filename, type;
    switch (format) {
      case 'markdown':
        content = convertToMarkdown(data, includeMetadata);
        filename = `claude-${conversationName || conversationId}.md`;
        type = 'text/markdown';
        break;
      case 'text':
        content = convertToText(data, includeMetadata);
        filename = `claude-${conversationName || conversationId}.txt`;
        type = 'text/plain';
        break;
      default:
        content = JSON.stringify(data, null, 2);
        filename = `claude-${conversationName || conversationId}.json`;
        type = 'application/json';
    }
    
    downloadFile(content, filename, type);
    showToast(`Exported: ${conversationName}`);
    
  } catch (error) {
    console.error('Export error:', error);
    showToast(`Failed to export: ${error.message}`, true);
  }
}

// Export all filtered conversations
async function exportAllFiltered() {
  const format = document.getElementById('exportFormat').value;
  const includeMetadata = document.getElementById('includeMetadata').checked;
  
  const button = document.getElementById('exportAllBtn');
  button.disabled = true;
  button.textContent = 'Preparing...';
  
  // Show progress modal
  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');
  progressModal.style.display = 'block';
  
  let cancelExport = false;
  const cancelButton = document.getElementById('cancelExport');
  cancelButton.onclick = () => {
    cancelExport = true;
    progressText.textContent = 'Cancelling...';
  };
  
  try {
    // Create a new ZIP file
    const zip = new JSZip();
    // Act on the selection if there is one, else the whole filtered list.
    const targets = getActionTargets();
    const total = targets.length;
    let completed = 0;
    let failed = 0;
    const failedConversations = [];
    
    progressText.textContent = `Exporting ${total} conversations...`;
    
    // Concurrency is user-configurable via the "Batch" field so it can be tuned
    // and measured empirically. Note the browser caps real HTTP/2 concurrency
    // (~100ish in-flight requests per host) regardless of this value, so very
    // large batch sizes plateau rather than going faster. Failures are caught
    // per-item and logged to export_summary.json. Defaults to 25 if invalid.
    const rawBatch = parseInt(document.getElementById('batchSize').value, 10);
    const batchSize = Number.isFinite(rawBatch) && rawBatch > 0
      ? Math.min(rawBatch, 7000)
      : 25;
    const interBatchDelayMs = 150;

    // Time just the fetch phase (excludes ZIP creation) so batch-size tuning
    // measures the thing it actually affects.
    const fetchStart = performance.now();
    for (let i = 0; i < total; i += batchSize) {
      if (cancelExport) break;
      
      const batch = targets.slice(i, Math.min(i + batchSize, total));
      const promises = batch.map(async (conv) => {
        try {
          const response = await fetch(
            `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conv.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`,
            {
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
              }
            }
          );
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          
          const data = await response.json();
          
          // Infer model if null
          data.model = inferModel(data);
          
          // Generate filename and content based on format
          let content, filename;
          const safeName = conv.name.replace(/[<>:"/\\|?*]/g, '_'); // Remove invalid filename characters
          
          switch (format) {
            case 'markdown':
              content = convertToMarkdown(data, includeMetadata);
              filename = `${safeName}.md`;
              break;
            case 'text':
              content = convertToText(data, includeMetadata);
              filename = `${safeName}.txt`;
              break;
            default: // json
              content = JSON.stringify(data, null, 2);
              filename = `${safeName}.json`;
          }
          
          // Add file to ZIP
          zip.file(filename, content);
          completed++;
          
        } catch (error) {
          console.error(`Failed to export ${conv.name}:`, error);
          failed++;
          failedConversations.push(conv.name);
        }
      });
      
      // Wait for batch to complete
      await Promise.all(promises);
      
      // Update progress
      const progress = Math.round((completed + failed) / total * 100);
      progressBar.style.width = `${progress}%`;
      progressStats.textContent = `${completed} succeeded, ${failed} failed out of ${total}`;
      
      // Small delay between batches (see batching rationale above)
      if (i + batchSize < total && !cancelExport) {
        await new Promise(resolve => setTimeout(resolve, interBatchDelayMs));
      }
    }

    const fetchSeconds = Number(((performance.now() - fetchStart) / 1000).toFixed(1));

    if (cancelExport) {
      progressModal.style.display = 'none';
      showToast('Export cancelled', true);
      return;
    }
    
    // Add a summary file
    const summary = {
      export_date: new Date().toISOString(),
      total_conversations: total,
      successful_exports: completed,
      failed_exports: failed,
      failed_conversations: failedConversations,
      format: format,
      include_metadata: includeMetadata,
      batch_size: batchSize,
      fetch_seconds: fetchSeconds,
      throughput_per_sec: fetchSeconds > 0 ? Number((completed / fetchSeconds).toFixed(1)) : null
    };
    zip.file('export_summary.json', JSON.stringify(summary, null, 2));
    
    // Generate and download the ZIP file
    progressText.textContent = 'Creating ZIP file...';
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6 // Medium compression
      }
    }, (metadata) => {
      // Update progress during ZIP creation
      const zipProgress = Math.round(metadata.percent);
      progressBar.style.width = `${zipProgress}%`;
    });
    
    // Download the ZIP file
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `claude-conversations-${new Date().toISOString().split('T')[0]}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    progressModal.style.display = 'none';
    
    if (failed > 0) {
      showToast(`Exported ${completed} of ${total} (${failed} failed) — batch ${batchSize}, ${fetchSeconds}s fetch. See export_summary.json.`);
    } else {
      showToast(`Exported all ${completed} conversations — batch ${batchSize}, ${fetchSeconds}s fetch.`);
    }
    
  } catch (error) {
    console.error('Export error:', error);
    progressModal.style.display = 'none';
    showToast(`Export failed: ${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Export All';
  }
}

// Open the type-to-confirm modal for deleting the target conversations
// (the selection if any, else everything matching the current filters).
function openDeleteModal() {
  const targets = getActionTargets();
  const total = targets.length;
  if (total === 0) return;

  const modal = document.getElementById('deleteModal');
  const warning = document.getElementById('deleteWarning');
  const sample = document.getElementById('deleteSample');
  const input = document.getElementById('deleteConfirmInput');
  const confirmBtn = document.getElementById('deleteConfirm');

  const scope = getSelectedVisible().length ? 'your selection' : 'everything currently shown by your filters';
  warning.innerHTML =
    `You are about to permanently delete <strong>${total}</strong> ` +
    `conversation${total === 1 ? '' : 's'} (${scope}).`;

  // Show up to 8 names so the user can sanity-check the selection.
  const names = targets.slice(0, 8).map(c => `• ${escapeHtml(c.name || '(untitled)')}`);
  if (total > 8) names.push(`…and ${total - 8} more`);
  sample.innerHTML = names.join('<br>');

  // Require typing "DELETE <count>" — count makes accidental confirmation harder.
  deleteConfirmPhrase = `DELETE ${total}`;
  document.getElementById('deletePhrase').textContent = deleteConfirmPhrase;
  input.placeholder = deleteConfirmPhrase;

  input.value = '';
  confirmBtn.disabled = true;
  modal.style.display = 'block';
  input.focus();
}

function closeDeleteModal() {
  document.getElementById('deleteModal').style.display = 'none';
}

// Background deletion. Batches are intentionally small ("for now") to stay well
// under rate limits. A single worker drains a queue; new deletes append to it and
// the top-right status line updates live. No progress modal / cancel UI yet.
const DELETE_BATCH_SIZE = 5;
const DELETE_INTER_BATCH_MS = 150;

let deleteQueue = [];            // conversations waiting to be deleted
let deleteWorkerRunning = false;
let deleteCancelled = false;     // set by the Cancel button; stops after current batch
let deleteTotal = 0;             // cumulative enqueued for the current run
let deleteDone = 0;              // succeeded so far this run
let deleteFailed = 0;            // failed so far this run
const enqueuedUuids = new Set(); // queued/in-flight — used to dedupe re-adds

// Confirm handler: queue the target conversations for background deletion.
function performDelete() {
  closeDeleteModal();
  const targets = getActionTargets();
  if (!targets.length) return;
  enqueueDeletes([...targets]);
}

// Queue conversations for deletion and remove them from the list + cache right
// away (optimistic). Anything that ends up NOT deleted — a failure, or a
// cancellation — is restored automatically; a manual refresh also re-fetches
// server truth as a backstop.
function enqueueDeletes(targets) {
  const fresh = targets.filter(c => !enqueuedUuids.has(c.uuid));
  if (!fresh.length) return;
  fresh.forEach(c => enqueuedUuids.add(c.uuid));
  deleteQueue.push(...fresh);
  deleteTotal += fresh.length;

  // Optimistic removal: drop from the visible list, selection, and cache now.
  const removing = new Set(fresh.map(c => c.uuid));
  allConversations = allConversations.filter(c => !removing.has(c.uuid));
  fresh.forEach(c => selectedUuids.delete(c.uuid));
  populateProjectFilter();
  applyFiltersAndSort();
  saveToCache();

  updateDeleteStatus();
  if (!deleteWorkerRunning) runDeleteWorker();
}

// Cancel the remaining queued deletions (already-sent ones can't be recalled).
function cancelDeletes() {
  if (!deleteWorkerRunning) return;
  deleteCancelled = true;
  updateDeleteStatus();
}

// Put conversations back into the list + cache (used to restore survivors).
function restoreConversations(convs) {
  if (!convs.length) return;
  const have = new Set(allConversations.map(c => c.uuid));
  convs.forEach(conv => { if (!have.has(conv.uuid)) allConversations.push(conv); });
  populateProjectFilter();
  applyFiltersAndSort();
  saveToCache();
}

// Update the top-right status line + toggle the Cancel button (blank when idle).
function updateDeleteStatus() {
  const bar = document.getElementById('deleteStatus');
  const text = document.getElementById('deleteStatusText');
  if (!bar || !text) return;
  const active = deleteWorkerRunning || deleteQueue.length > 0;
  bar.classList.toggle('active', active);
  if (!active) { text.textContent = ''; return; }
  const processed = deleteDone + deleteFailed;
  const failedText = deleteFailed ? ` · ${deleteFailed} failed` : '';
  text.textContent = deleteCancelled
    ? `Cancelling… ${processed}/${deleteTotal}`
    : `Deleting ${processed}/${deleteTotal}${failedText}`;
}

// Drain the deletion queue in small batches. Items enqueued while this runs are
// picked up in later iterations (the while-loop re-checks the queue each pass).
async function runDeleteWorker() {
  deleteWorkerRunning = true;
  deleteCancelled = false;
  updateDeleteStatus();

  const restore = []; // conversations that were removed but not actually deleted

  while (deleteQueue.length > 0 && !deleteCancelled) {
    const batch = deleteQueue.splice(0, DELETE_BATCH_SIZE);
    await Promise.all(batch.map(async (conv) => {
      try {
        const response = await fetch(
          `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conv.uuid}`,
          { method: 'DELETE', credentials: 'include', headers: { 'Accept': 'application/json' } }
        );
        // Treat 404 as already-gone (success) rather than an error.
        if (!response.ok && response.status !== 404) {
          throw new Error(`HTTP ${response.status}`);
        }
        deleteDone++;
      } catch (error) {
        console.error(`Failed to delete ${conv.name}:`, error);
        deleteFailed++;
        restore.push(conv); // wasn't deleted → bring it back
      }
    }));
    updateDeleteStatus();
    if (deleteQueue.length > 0 && !deleteCancelled) {
      await new Promise(resolve => setTimeout(resolve, DELETE_INTER_BATCH_MS));
    }
  }

  // Cancelled: whatever's still queued was never sent → restore it.
  const cancelledCount = deleteCancelled ? deleteQueue.length : 0;
  if (cancelledCount) restore.push(...deleteQueue);
  deleteQueue = [];

  restoreConversations(restore);

  const done = deleteDone;
  const failed = deleteFailed;
  const wasCancelled = deleteCancelled;
  // Reset the run so the next delete starts a fresh count.
  deleteTotal = 0;
  deleteDone = 0;
  deleteFailed = 0;
  enqueuedUuids.clear();
  deleteWorkerRunning = false;
  deleteCancelled = false;
  updateDeleteStatus();

  if (wasCancelled) {
    showToast(`Cancelled — deleted ${done}${cancelledCount ? `, ${cancelledCount} kept` : ''}` +
      `${failed ? `, ${failed} failed (restored)` : ''}.`, true);
  } else if (failed > 0) {
    showToast(`Deleted ${done} (${failed} failed — restored to list).`, true);
  } else {
    showToast(`Deleted ${done} conversation${done === 1 ? '' : 's'}.`);
  }
}

// Conversion functions are now imported from utils.js
// Functions available: getCurrentBranch, convertToMarkdown, convertToText, downloadFile

// Show error message
function showError(message) {
  const tableContent = document.getElementById('tableContent');
  tableContent.innerHTML = `<div class="error">${message}</div>`;
}

// Show toast notification
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#d32f2f' : '#333';
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Setup event listeners
function setupEventListeners() {
  // Search input
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', (e) => {
    const searchBox = document.getElementById('searchBox');
    if (e.target.value) {
      searchBox.classList.add('has-text');
    } else {
      searchBox.classList.remove('has-text');
    }
    applyFiltersAndSort();
  });
  
  // Clear search
  document.getElementById('clearSearch').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchBox').classList.remove('has-text');
    applyFiltersAndSort();
  });
  
  // Model filter
  document.getElementById('modelFilter').addEventListener('change', applyFiltersAndSort);

  // Project filter
  document.getElementById('projectFilter').addEventListener('change', applyFiltersAndSort);

  // "Open in this window" filter — re-scan tabs when toggled on so it's fresh.
  document.getElementById('openTabsOnly').addEventListener('change', async (e) => {
    if (e.target.checked) await refreshOpenTabs();
    applyFiltersAndSort();
  });

  // Manual re-scan of open tabs
  document.getElementById('refreshOpenTabs').addEventListener('click', async () => {
    await refreshOpenTabs();
    showToast(`Found ${openTabUuids.size} open chat tab(s) in this window`);
    applyFiltersAndSort();
  });

  // Delete filtered conversations (type-to-confirm)
  document.getElementById('deleteAllBtn').addEventListener('click', openDeleteModal);
  document.getElementById('deleteCancel').addEventListener('click', closeDeleteModal);
  document.getElementById('deleteConfirm').addEventListener('click', performDelete);
  document.getElementById('cancelDeleteBtn').addEventListener('click', cancelDeletes);
  document.getElementById('deleteConfirmInput').addEventListener('input', (e) => {
    document.getElementById('deleteConfirm').disabled = e.target.value.trim() !== deleteConfirmPhrase;
  });

  // Date range filters (created + last edited)
  const dateInputs = ['dateFrom', 'dateTo', 'updatedFrom', 'updatedTo'];
  dateInputs.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      syncDateConstraints();
      applyFiltersAndSort();
    });
  });

  // Clear created-date filter
  document.getElementById('clearDates').addEventListener('click', () => {
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    syncDateConstraints();
    applyFiltersAndSort();
  });

  // Clear edited-date filter
  document.getElementById('clearUpdated').addEventListener('click', () => {
    document.getElementById('updatedFrom').value = '';
    document.getElementById('updatedTo').value = '';
    syncDateConstraints();
    applyFiltersAndSort();
  });
  
  // Sort dropdown
  document.getElementById('sortBy').addEventListener('change', (e) => {
    currentSort = e.target.value;
    applyFiltersAndSort();
  });
  
  // Export all button
  document.getElementById('exportAllBtn').addEventListener('click', exportAllFiltered);

  // Manual refresh of the conversation list (force revalidate)
  document.getElementById('refreshBtn').addEventListener('click', () => revalidate(false));

  // Keep the "updated Xm ago" label from going stale while the page sits open.
  setInterval(() => updateCacheStatus(), 60 * 1000);

  setupSelectionHandlers();
}

// Row selection: click / shift-click range / cmd-toggle / click-and-drag.
// Listeners are delegated onto #tableContent once (the table HTML is re-rendered
// in place, so the container element persists across renders).
function setupSelectionHandlers() {
  const tableContent = document.getElementById('tableContent');

  // Resolve an event target to its row index, or null if the click landed on an
  // interactive element (link/button) — those keep their own behavior.
  const rowIndexFromEvent = (e) => {
    if (e.target.closest('a, button')) return null;
    const row = e.target.closest('tr[data-index]');
    return row ? parseInt(row.dataset.index, 10) : null;
  };

  tableContent.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left button only
    const index = rowIndexFromEvent(e);
    if (index === null) return;

    e.preventDefault(); // suppress native text selection while (drag-)selecting

    if (e.shiftKey && selectionAnchorIndex !== null) {
      // Shift-click: add the contiguous range from the anchor to the selection.
      selectRange(selectionAnchorIndex, index, true);
      applySelection();
      return;
    }

    if (e.metaKey || e.ctrlKey) {
      // Same as a plain click now (toggle), but never starts a drag.
      toggleRow(index);
      selectionAnchorIndex = index;
      applySelection();
      return;
    }

    // Plain press: defer the decision. A press-without-move is a toggle (handled
    // on mouseup); a press-then-move becomes a drag that ADDS the swept range.
    isPointerDown = true;
    pointerAnchorIndex = index;
    selectionAnchorIndex = index;
    dragMoved = false;
    dragLastIndex = index;
    preDragSelection = new Set(selectedUuids);
  });

  // Turn a press-and-move into an additive range drag (grows/shrinks live off
  // the pre-drag snapshot, so backtracking works).
  tableContent.addEventListener('mouseover', (e) => {
    if (!isPointerDown) return;
    const row = e.target.closest('tr[data-index]');
    if (!row) return;
    const index = parseInt(row.dataset.index, 10);
    if (index === dragLastIndex) return;
    dragLastIndex = index;
    dragMoved = true;
    selectedUuids = new Set(preDragSelection);
    selectRange(pointerAnchorIndex, index, true);
    applySelection();
  });

  document.addEventListener('mouseup', () => {
    // A plain press that never moved = a click = toggle that one row.
    if (isPointerDown && !dragMoved) {
      toggleRow(pointerAnchorIndex);
      applySelection();
    }
    isPointerDown = false;
    dragMoved = false;
    dragLastIndex = null;
    preDragSelection = null;
  });

  // Esc: close the delete modal if open, otherwise deselect everything.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('deleteModal');
    if (modal && modal.style.display === 'block') { closeDeleteModal(); return; }
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    clearSelection();
  });

  // Selection bar actions
  document.getElementById('openSelectedBtn').addEventListener('click', openSelectedAsText);
  document.getElementById('clearSelectionBtn').addEventListener('click', clearSelection);
}
