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

// Default model timeline for null models
// Each entry represents when that model became the default
const DEFAULT_MODEL_TIMELINE = [
  { date: new Date('2024-01-01'), model: 'claude-3-sonnet-20240229' }, // Before June 20, 2024
  { date: new Date('2024-06-20'), model: 'claude-3-5-sonnet-20240620' }, // Starting June 20, 2024
  { date: new Date('2024-10-22'), model: 'claude-3-5-sonnet-20241022' }, // Starting October 22, 2024
  { date: new Date('2025-02-24'), model: 'claude-3-7-sonnet-20250219' }, // Starting February 24, 2025
  { date: new Date('2025-05-22'), model: 'claude-sonnet-4-20250514' }, // Starting May 22, 2025
  { date: new Date('2025-09-29'), model: 'claude-sonnet-4-5-20250929' }, // Starting September 29, 2025
  { date: new Date('2026-02-17'), model: 'claude-sonnet-4-6' } // Starting February 17, 2026
];

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

// Infer model for conversations with null model based on date
function inferModel(conversation) {
  if (conversation.model) {
    return conversation.model;
  }
  
  // Use created_at date to determine which default model was active
  const conversationDate = new Date(conversation.created_at);
  
  // Find the appropriate model based on the conversation date
  // Start from the end and work backwards to find the right period
  for (let i = DEFAULT_MODEL_TIMELINE.length - 1; i >= 0; i--) {
    if (conversationDate >= DEFAULT_MODEL_TIMELINE[i].date) {
      return DEFAULT_MODEL_TIMELINE[i].model;
    }
  }
  
  // If date is before all known dates, use the first model
  return DEFAULT_MODEL_TIMELINE[0].model;
}

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

  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tabs.forEach(tab => {
      if (!tab.url) return;
      const match = tab.url.match(/claude\.ai\/chat\/([a-f0-9-]+)/i);
      if (match) openTabUuids.add(match[1]);
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
  
  filteredConversations.forEach(conv => {
    const updatedDate = new Date(conv.updated_at).toLocaleDateString();
    const createdDate = new Date(conv.created_at).toLocaleDateString();
    const modelBadgeClass = getModelBadgeClass(conv.model);
    
    html += `
      <tr data-id="${conv.uuid}">
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
            <button class="btn-small btn-view" data-id="${conv.uuid}">
              View
            </button>
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
  
  // Add export button listeners
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', (e) => {
      exportConversation(e.target.dataset.id, e.target.dataset.name);
    });
  });
  
  // Add view button listeners
  document.querySelectorAll('.btn-view').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const conversationId = e.target.dataset.id;
      window.open(`https://claude.ai/chat/${conversationId}`, '_blank');
    });
  });
  
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
    const total = filteredConversations.length;
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
      
      const batch = filteredConversations.slice(i, Math.min(i + batchSize, total));
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

// Open the type-to-confirm modal for deleting the currently filtered conversations.
function openDeleteModal() {
  const total = filteredConversations.length;
  if (total === 0) return;

  const modal = document.getElementById('deleteModal');
  const warning = document.getElementById('deleteWarning');
  const sample = document.getElementById('deleteSample');
  const input = document.getElementById('deleteConfirmInput');
  const confirmBtn = document.getElementById('deleteConfirm');

  warning.innerHTML =
    `You are about to permanently delete <strong>${total}</strong> ` +
    `conversation${total === 1 ? '' : 's'} (everything currently shown by your filters).`;

  // Show up to 8 names so the user can sanity-check the selection.
  const names = filteredConversations.slice(0, 8).map(c => `• ${escapeHtml(c.name || '(untitled)')}`);
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

// Delete the filtered conversations via the API, with batched concurrency and
// a progress bar (reuses the export progress modal). Irreversible.
async function performDelete() {
  closeDeleteModal();

  const targets = [...filteredConversations];
  const total = targets.length;

  const progressModal = document.getElementById('progressModal');
  const progressTitle = document.getElementById('progressTitle');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');

  progressTitle.textContent = 'Deleting Conversations';
  progressText.textContent = `Deleting ${total} conversations...`;
  progressBar.style.width = '0%';
  progressStats.textContent = '';
  progressModal.style.display = 'block';

  let cancelDelete = false;
  const cancelButton = document.getElementById('cancelExport');
  cancelButton.onclick = () => {
    cancelDelete = true;
    progressText.textContent = 'Cancelling...';
  };

  let deleted = 0;
  let failed = 0;
  const failedNames = [];
  const deletedUuids = new Set();

  // Reuse the user's configured batch size for delete concurrency.
  const rawBatch = parseInt(document.getElementById('batchSize').value, 10);
  const batchSize = Number.isFinite(rawBatch) && rawBatch > 0 ? Math.min(rawBatch, 7000) : 25;

  try {
    for (let i = 0; i < total; i += batchSize) {
      if (cancelDelete) break;

      const batch = targets.slice(i, Math.min(i + batchSize, total));
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
          deleted++;
          deletedUuids.add(conv.uuid);
        } catch (error) {
          console.error(`Failed to delete ${conv.name}:`, error);
          failed++;
          failedNames.push(conv.name);
        }
      }));

      const progress = Math.round((deleted + failed) / total * 100);
      progressBar.style.width = `${progress}%`;
      progressStats.textContent = `${deleted} deleted, ${failed} failed out of ${total}`;

      if (i + batchSize < total && !cancelDelete) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    // Drop deleted conversations from local state and refresh the view.
    allConversations = allConversations.filter(c => !deletedUuids.has(c.uuid));
    populateProjectFilter();
    applyFiltersAndSort();

    progressModal.style.display = 'none';

    if (failed > 0) {
      showToast(`Deleted ${deleted} of ${total} (${failed} failed). See console for details.`, true);
    } else if (cancelDelete) {
      showToast(`Cancelled — deleted ${deleted} of ${total} before stopping.`, true);
    } else {
      showToast(`Deleted ${deleted} conversation${deleted === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    console.error('Delete error:', error);
    progressModal.style.display = 'none';
    showToast(`Delete failed: ${error.message}`, true);
  } finally {
    // Restore the progress modal title for future exports.
    progressTitle.textContent = 'Exporting Conversations';
    cancelButton.onclick = null;
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
}
