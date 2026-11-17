(() => {
  const keywords = ['Bags', 'Pouches', 'Flowers', 'Door hangings', 'Wall hangings', 'Home decor', 'Accessories'];
  const normalize = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').trim();
  const productList = typeof products === 'undefined' ? [] : products;

  for (const form of document.querySelectorAll('[data-product-search]')) {
    const input = form.querySelector('input[name="q"]');
    const suggestions = form.querySelector('.search-suggestions');
    let timer;

    function close() {
      suggestions.hidden = true;
      suggestions.replaceChildren();
      input.setAttribute('aria-expanded', 'false');
    }

    function show() {
      const query = input.value.trim().slice(0, 80);
      const needle = normalize(query);
      if (!needle) return close();
      const matches = [];
      for (const keyword of keywords) {
        if (normalize(keyword).includes(needle) || needle.includes(normalize(keyword).replace(/s$/, ''))) {
          matches.push({ label: keyword, href: `/shop?q=${encodeURIComponent(keyword)}` });
        }
      }
      for (const product of productList) {
        if (normalize([product.name, ...(product.tags || [])].join(' ')).includes(needle)) {
          matches.push({ label: product.name, href: `/products/${encodeURIComponent(product.id)}` });
        }
        if (matches.length >= 5) break;
      }
      suggestions.replaceChildren();
      const searchAll = { label: `Search for “${query}”`, href: `/shop?q=${encodeURIComponent(query)}` };
      for (const match of [searchAll, ...matches.slice(0, 5)]) {
        const link = document.createElement('a');
        link.href = match.href;
        link.textContent = match.label;
        link.setAttribute('role', 'option');
        suggestions.append(link);
      }
      suggestions.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(show, 180);
    });
    input.addEventListener('focus', show);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowDown' && !suggestions.hidden) {
        event.preventDefault();
        suggestions.querySelector('a')?.focus();
      }
    });
    suggestions.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); input.focus(); }
    });
    document.addEventListener('click', event => {
      if (!form.contains(event.target)) close();
    });
  }
})();
