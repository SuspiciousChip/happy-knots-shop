(() => {
  for (const frame of document.querySelectorAll('.featured-tile, .product-photo, .product-detail-image')) {
    const image = frame.querySelector('img');
    if (!image || image.complete) continue;
    frame.classList.add('image-loading');
    const finish = () => frame.classList.remove('image-loading');
    image.addEventListener('load', finish, { once: true });
    image.addEventListener('error', finish, { once: true });
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if ('IntersectionObserver' in window) {
    const titles = document.querySelectorAll('.hero h1, .featured-intro h2, .section-head h2, .story h2');
    const titleObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-flipped');
        titleObserver.unobserve(entry.target);
      }
    }, { threshold: 0.2, rootMargin: '0px 0px -6% 0px' });
    titles.forEach(title => {
      title.classList.add('viewport-flip');
      titleObserver.observe(title);
    });
  }
  const targets = document.querySelectorAll('[data-reveal], .catalog-layout h1, .catalog-layout .product, .product-detail-copy');
  if (!targets.length || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -32px 0px' });
  targets.forEach((target, index) => {
    target.dataset.reveal = '';
    if (target.classList.contains('product')) target.style.setProperty('--reveal-delay', `${Math.min(index % 3, 2) * 70}ms`);
    observer.observe(target);
  });
  document.documentElement.classList.add('motion-ready');
})();
