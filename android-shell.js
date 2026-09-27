
  (function() {
    var isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (!isMobile) {
      document.body.insertAdjacentHTML('beforeend', 
        '<div style="position:fixed;inset:0;background:#121212;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;z-index:9999;text-align:center;padding:20px;">' +
        '<svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#E41E3F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:20px;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>' +
        '<h2 style="margin:0 0 10px;font-size:1.5rem;font-weight:800;">Access Restricted</h2>' +
        '<p style="margin:0;color:#a8a8a8;font-size:1.1rem;line-height:1.5;max-width:400px;">This application is exclusively optimized for mobile devices and tablets. Please open this link on your smartphone.</p>' +
        '</div>'
      );
    }
  })();

