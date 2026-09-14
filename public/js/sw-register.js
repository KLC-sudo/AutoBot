// sw-register.js — Cache-clearing service worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js?v=4').then((reg) => {
    reg.active && navigator.serviceWorker.ready.then(() => {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
    });
  }).catch(() => {});
}
