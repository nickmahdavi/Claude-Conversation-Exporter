// Plaintext conversation viewer.
// Opened as view.html?id=<conversation-uuid> in its own tab. Fetches the
// conversation and renders it using the exact same Markdown the .md export
// produces (convertToMarkdown from utils.js), shown as plain text.

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function getOrgId() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['organizationId'], (result) => resolve(result.organizationId));
  });
}

function showError(message) {
  const content = document.getElementById('content');
  content.classList.add('error');
  content.textContent = message;
}

document.addEventListener('DOMContentLoaded', async () => {
  const titleEl = document.getElementById('title');
  const content = document.getElementById('content');
  const copyBtn = document.getElementById('copyBtn');

  const uuid = getParam('id');
  if (!uuid) {
    titleEl.textContent = 'Conversation';
    showError('No conversation id provided in the URL.');
    return;
  }

  const orgId = await getOrgId();
  if (!orgId) {
    titleEl.textContent = 'Conversation';
    showError('Organization ID not configured. Set it in the extension options.');
    return;
  }

  try {
    // Drop render_all_tools: convertToMarkdown only emits text content, so the
    // tool-render payload was just inflating memory for no visible difference.
    const response = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${uuid}?tree=True&rendering_mode=messages`,
      { credentials: 'include', headers: { 'Accept': 'application/json' } }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let data = await response.json();
    data.model = inferModel(data); // match the export's model inference

    const name = data.name || 'Untitled Conversation';
    document.title = name;
    titleEl.textContent = name;

    // Include metadata to match the .md export's default format. We render
    // straight into the DOM and don't keep a second copy of the string in JS —
    // Copy reads it back from the <pre>. Then drop the big API payload so it
    // can be garbage-collected for the life of the tab.
    content.textContent = convertToMarkdown(data, true);
    data = null;

    copyBtn.style.display = '';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(content.textContent);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch (err) {
        console.error('Copy failed:', err);
        copyBtn.textContent = 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      }
    });
  } catch (error) {
    console.error('Failed to load conversation:', error);
    titleEl.textContent = 'Conversation';
    showError(`Failed to load conversation: ${error.message}`);
  }
});
