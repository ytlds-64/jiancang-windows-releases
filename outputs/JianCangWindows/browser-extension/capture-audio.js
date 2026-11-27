'use strict';

const success = document.getElementById('success');
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'jiancang:capture-success-sound' ||
      sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js')) return;
  success.currentTime = 0;
  success.play().then(() => respond({ ok: true }), () => respond({ ok: false }));
  return true;
});
