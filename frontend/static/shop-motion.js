(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
