import type { SelloraDb } from './db';
import type { AppEnvConfig } from './context';

export interface SeoSettingsRecord {
  siteTitle: string;
  metaDescription: string;
  canonicalBaseUrl: string;
  defaultOgImage: string;
  indexingEnabled: boolean;
  googleSiteVerification: string;
  gaMeasurementId: string;
  aboutSeoTitle: string;
  aboutSeoDescription: string;
  faqSeoTitle: string;
  faqSeoDescription: string;
  shopSeoTitle: string;
  shopSeoDescription: string;
}

export const DEFAULT_SEO_SETTINGS: SeoSettingsRecord = {
  siteTitle: 'SELLORA — Commerce without limits.',
  metaDescription:
    'Shop curated lifestyle essentials, electronics, and leather goods on SELLORA. Fast delivery across Nigeria with transparent NGN pricing and verified tracking.',
  canonicalBaseUrl: '',
  defaultOgImage: '/src/assets/images/hero_sellora_editorial_1794648058731.jpg',
  indexingEnabled: true,
  googleSiteVerification: '',
  gaMeasurementId: '',
  aboutSeoTitle: 'About SELLORA — Commerce without limits.',
  aboutSeoDescription:
    'Learn about SELLORA, a single-store Nigerian ecommerce platform operating in NGN with verified fulfilment and nationwide delivery.',
  faqSeoTitle: 'Frequently Asked Questions — SELLORA',
  faqSeoDescription:
    'Answers on SELLORA bank transfer verification, Nigerian State & LGA delivery zones, order tracking, and return reviews.',
  shopSeoTitle: 'Shop All Products — SELLORA',
  shopSeoDescription:
    'Browse all active SELLORA audio, leather carry, timepiece, and workspace hardware in Nigerian Naira (NGN).',
};

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeGoogleSiteVerification(value?: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  if (/^(REPLACE_WITH|your-verification|placeholder)/i.test(trimmed)) return '';
  return trimmed;
}

export function sanitizeGaMeasurementId(value?: string): string {
  const trimmed = (value || '').trim();
  if (!/^G-[A-Z0-9]{4,}$/i.test(trimmed) || /^G-X+$/i.test(trimmed)) return '';
  return trimmed;
}

export async function getEffectiveSeoConfig(
  db: SelloraDb,
  env: Partial<AppEnvConfig>
): Promise<SeoSettingsRecord> {
  const row = await db
    .get<{ value_json: string }>(`SELECT value_json FROM store_settings WHERE key = 'seo'`)
    .catch(() => null);
  let stored: Partial<SeoSettingsRecord> = {};
  if (row?.value_json) {
    try {
      stored = JSON.parse(row.value_json);
    } catch {
      stored = {};
    }
  }
  const resolvedBase = (stored.canonicalBaseUrl || env.appUrl || '').replace(/\/+$/, '');
  return {
    ...DEFAULT_SEO_SETTINGS,
    ...stored,
    canonicalBaseUrl: resolvedBase,
    googleSiteVerification:
      sanitizeGoogleSiteVerification(stored.googleSiteVerification) ||
      sanitizeGoogleSiteVerification(env.googleSiteVerification),
    gaMeasurementId:
      sanitizeGaMeasurementId(stored.gaMeasurementId) ||
      sanitizeGaMeasurementId(env.gaMeasurementId),
    indexingEnabled:
      stored.indexingEnabled !== undefined ? Boolean(stored.indexingEnabled) : true,
  };
}

export async function generateRobotsTxt(
  db: SelloraDb,
  env: Partial<AppEnvConfig>,
  fallbackOrigin: string
): Promise<string> {
  const seo = await getEffectiveSeoConfig(db, env);
  const baseUrl = (seo.canonicalBaseUrl || fallbackOrigin).replace(/\/+$/, '');

  if (!seo.indexingEnabled) {
    return [
      'User-agent: *',
      'Disallow: /',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
      '',
    ].join('\n');
  }

  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /account',
    'Disallow: /checkout',
    'Disallow: /track',
    'Disallow: /*?*view=admin',
    'Disallow: /*?*view=account',
    'Disallow: /*?*view=checkout',
    'Disallow: /*?*view=track',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

export async function generateSitemapXml(
  db: SelloraDb,
  env: Partial<AppEnvConfig>,
  fallbackOrigin: string
): Promise<string> {
  const seo = await getEffectiveSeoConfig(db, env);
  const base = (seo.canonicalBaseUrl || fallbackOrigin).replace(/\/+$/, '');

  const [products, categories, collections] = await Promise.all([
    db.all<{ slug: string; updated_at: string }>(
      `SELECT slug, updated_at FROM products WHERE status = 'active' ORDER BY is_featured DESC, created_at DESC`
    ),
    db.all<{ slug: string; created_at: string }>(
      `SELECT slug, created_at FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC`
    ),
    db.all<{ slug: string; created_at: string }>(
      `SELECT slug, created_at FROM collections WHERE is_active = 1 ORDER BY is_featured DESC, name ASC`
    ),
  ]);

  const entries: Array<{ loc: string; lastmod?: string; changefreq: string; priority: string }> = [
    { loc: `${base}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${base}/shop`, changefreq: 'daily', priority: '0.9' },
    { loc: `${base}/about`, changefreq: 'monthly', priority: '0.6' },
    { loc: `${base}/contact`, changefreq: 'monthly', priority: '0.6' },
    { loc: `${base}/faq`, changefreq: 'monthly', priority: '0.6' },
    { loc: `${base}/policies`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${base}/privacy-policy`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${base}/terms`, changefreq: 'monthly', priority: '0.5' },
  ];

  for (const cat of categories) {
    if (!cat.slug) continue;
    entries.push({
      loc: `${base}/category/${encodeURIComponent(cat.slug)}`,
      lastmod: cat.created_at ? cat.created_at.slice(0, 10) : undefined,
      changefreq: 'weekly',
      priority: '0.8',
    });
  }

  for (const col of collections) {
    if (!col.slug) continue;
    entries.push({
      loc: `${base}/?collection=${encodeURIComponent(col.slug)}`,
      lastmod: col.created_at ? col.created_at.slice(0, 10) : undefined,
      changefreq: 'weekly',
      priority: '0.7',
    });
  }

  for (const p of products) {
    if (!p.slug) continue;
    entries.push({
      loc: `${base}/product/${encodeURIComponent(p.slug)}`,
      lastmod: p.updated_at ? p.updated_at.slice(0, 10) : undefined,
      changefreq: 'weekly',
      priority: '0.9',
    });
  }

  const urlsXml = entries
    .map(
      (e) =>
        `  <url>\n    <loc>${escapeXml(e.loc)}</loc>${e.lastmod ? `\n    <lastmod>${escapeXml(e.lastmod)}</lastmod>` : ''}\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlsXml}\n</urlset>`;
}

function formatServerNgn(kobo: number): string {
  const naira = kobo / 100;
  return `₦${naira.toLocaleString('en-NG', {
    minimumFractionDigits: kobo % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export async function renderSeoHtmlResponse(
  html: string,
  requestUrl: URL,
  db: SelloraDb,
  env: Partial<AppEnvConfig>
): Promise<{ html: string; status: number }> {
  const seo = await getEffectiveSeoConfig(db, env);
  const base = (seo.canonicalBaseUrl || requestUrl.origin).replace(/\/+$/, '');
  const path = requestUrl.pathname;
  const viewParam = requestUrl.searchParams.get('view') || '';
  const productSlugParam =
    requestUrl.searchParams.get('product') ||
    (path.startsWith('/product/') ? decodeURIComponent(path.slice('/product/'.length)) : '');
  const categorySlugParam =
    requestUrl.searchParams.get('category') ||
    (path.startsWith('/category/') ? decodeURIComponent(path.slice('/category/'.length)) : '');

  const isPrivateRoute =
    path.startsWith('/admin') ||
    path.startsWith('/account') ||
    path.startsWith('/checkout') ||
    path.startsWith('/track') ||
    path.startsWith('/api/') ||
    ['admin', 'account', 'checkout', 'track'].includes(viewParam);

  const knownStaticPaths = new Set([
    '/',
    '/shop',
    '/about',
    '/contact',
    '/faq',
    '/policies',
    '/privacy-policy',
    '/terms',
  ]);

  let title = seo.siteTitle;
  let description = seo.metaDescription;
  let canonical = `${base}${path === '/' ? '/' : path}`;
  let ogImage = seo.defaultOgImage;
  let ogType = 'website';
  let status = 200;
  let ssrBodyHtml = '';
  let jsonLdGraph: Record<string, unknown>[] = [];

  const themeRow = await db
    .get<{ value_json: string }>(`SELECT value_json FROM store_settings WHERE key = 'theme'`)
    .catch(() => null);
  let theme: Record<string, any> = {};
  if (themeRow?.value_json) {
    try {
      theme = JSON.parse(themeRow.value_json);
    } catch {
      theme = {};
    }
  }
  const storeName = String(theme.storeName || 'SELLORA');

  if (!isPrivateRoute) {
    jsonLdGraph.push(
      {
        '@type': 'Store',
        name: storeName,
        description: seo.metaDescription,
        url: base,
        currenciesAccepted: 'NGN',
        areaServed: 'NG',
        ...(theme.contactEmail ? { email: theme.contactEmail } : {}),
        ...(theme.contactPhone ? { telephone: theme.contactPhone } : {}),
      },
      {
        '@type': 'WebSite',
        name: storeName,
        url: base,
        potentialAction: {
          '@type': 'SearchAction',
          target: `${base}/shop?q={search_term_string}`,
          'query-input': 'required name=search_term_string',
        },
      }
    );
  }

  if (!isPrivateRoute && productSlugParam) {
    const product = await db
      .get<Record<string, unknown>>(
        `SELECT p.id, p.name, p.slug, p.sku, p.brand, p.short_description, p.description, p.price_kobo, p.sale_price_kobo,
                p.track_inventory, p.seo_title, p.seo_description, p.seo_canonical_url, p.seo_image_url, p.image_alt, p.media_json,
                c.name as category_name, c.slug as category_slug
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE (p.slug = ? OR p.id = ?) AND p.status = 'active' LIMIT 1`,
        [productSlugParam, productSlugParam]
      )
      .catch(() => null);

    if (!product) {
      status = 404;
      title = 'Product Not Found — SELLORA';
      description = 'The requested product could not be found in the SELLORA catalog.';
      ssrBodyHtml = `<main class="max-w-3xl mx-auto px-6 py-16"><h1>Product Not Found</h1><p>This item is unavailable or no longer listed.</p><a href="/shop">Browse SELLORA Catalog</a></main>`;
    } else {
      title = String(product.seo_title || `${product.name} — SELLORA`);
      description = String(product.seo_description || product.short_description || seo.metaDescription);
      canonical = String(
        product.seo_canonical_url || `${base}/product/${encodeURIComponent(String(product.slug))}`
      );
      let firstMedia = '';
      try {
        const parsed = JSON.parse(String(product.media_json || '[]'));
        if (Array.isArray(parsed) && parsed[0]) firstMedia = String(parsed[0]);
      } catch {
        firstMedia = '';
      }
      ogImage = String(product.seo_image_url || firstMedia || seo.defaultOgImage);
      ogType = 'product';

      const stockRow = await db
        .get<{ total_stock: number | null }>(
          `SELECT SUM(stock_quantity) as total_stock FROM product_variants WHERE product_id = ? AND is_active = 1`,
          [product.id]
        )
        .catch(() => null);
      const inStock =
        !product.track_inventory || Number(stockRow?.total_stock ?? 0) > 0;
      const effectiveKobo = Number(product.sale_price_kobo ?? product.price_kobo ?? 0);
      const absImg = ogImage.startsWith('http')
        ? ogImage
        : `${base}${ogImage.startsWith('/') ? '' : '/'}${ogImage}`;

      jsonLdGraph.push({
        '@type': 'Product',
        name: product.name,
        description: String(product.description || product.short_description || ''),
        sku: product.sku,
        url: canonical,
        image: absImg ? [absImg] : undefined,
        brand: {
          '@type': 'Brand',
          name: String(product.brand || storeName),
        },
        offers: {
          '@type': 'Offer',
          priceCurrency: 'NGN',
          price: (effectiveKobo / 100).toFixed(2),
          availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          url: canonical,
        },
      });

      ssrBodyHtml = `<main class="max-w-5xl mx-auto px-6 py-12">
        <nav aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/shop">Shop</a>${product.category_slug ? ` / <a href="/category/${escapeHtmlAttr(String(product.category_slug))}">${escapeXml(String(product.category_name || product.category_slug))}</a>` : ''}</nav>
        <h1>${escapeXml(String(product.name))}</h1>
        <p>${escapeXml(formatServerNgn(effectiveKobo))} · ${inStock ? 'In Stock' : 'Out of Stock'} · SKU ${escapeXml(String(product.sku || ''))}</p>
        ${firstMedia ? `<img src="${escapeHtmlAttr(firstMedia)}" alt="${escapeHtmlAttr(String(product.image_alt || product.name))}" />` : ''}
        <p>${escapeXml(String(product.short_description || ''))}</p>
        <div>${escapeXml(String(product.description || ''))}</div>
      </main>`;
    }
  } else if (!isPrivateRoute && categorySlugParam) {
    const category = await db
      .get<Record<string, unknown>>(
        `SELECT id, name, slug, description, seo_title, seo_description
         FROM categories WHERE slug = ? AND is_active = 1 LIMIT 1`,
        [categorySlugParam]
      )
      .catch(() => null);

    if (!category) {
      status = 404;
      title = 'Category Not Found — SELLORA';
      description = 'The requested store category could not be found.';
      ssrBodyHtml = `<main class="max-w-3xl mx-auto px-6 py-16"><h1>Category Not Found</h1><p>Explore active categories on SELLORA.</p><a href="/shop">View All Products</a></main>`;
    } else {
      title = String(category.seo_title || `${category.name} — SELLORA`);
      description = String(category.seo_description || category.description || seo.metaDescription);
      canonical = `${base}/category/${encodeURIComponent(String(category.slug))}`;
      const catProducts = await db
        .all<Record<string, unknown>>(
          `SELECT name, slug, short_description, price_kobo, sale_price_kobo FROM products WHERE category_id = ? AND status = 'active' ORDER BY is_featured DESC, created_at DESC LIMIT 24`,
          [category.id]
        )
        .catch(() => []);
      const itemsHtml = catProducts
        .map(
          (p) =>
            `<li><a href="/product/${escapeHtmlAttr(String(p.slug))}">${escapeXml(String(p.name))}</a> — ${escapeXml(formatServerNgn(Number(p.sale_price_kobo ?? p.price_kobo ?? 0)))}<p>${escapeXml(String(p.short_description || ''))}</p></li>`
        )
        .join('');
      ssrBodyHtml = `<main class="max-w-6xl mx-auto px-6 py-12"><h1>${escapeXml(String(category.name))}</h1><p>${escapeXml(description)}</p><ul>${itemsHtml}</ul></main>`;
    }
  } else if (!isPrivateRoute) {
    if (!knownStaticPaths.has(path)) {
      status = 404;
      title = 'Page Not Found — SELLORA';
      description = 'The requested SELLORA page does not exist.';
      ssrBodyHtml = `<main class="max-w-3xl mx-auto px-6 py-16"><h1>404 — Page Not Found</h1><p>The page you requested could not be found.</p><a href="/">Return Home</a> · <a href="/shop">Shop Catalog</a></main>`;
    } else if (path === '/' || path === '/shop' || viewParam === 'shop') {
      if (path === '/shop' || viewParam === 'shop') {
        title = seo.shopSeoTitle;
        description = seo.shopSeoDescription;
        canonical = `${base}/shop`;
      }
      const activeProducts = await db
        .all<Record<string, unknown>>(
          `SELECT name, slug, short_description, price_kobo, sale_price_kobo FROM products WHERE status = 'active' ORDER BY is_featured DESC, created_at DESC LIMIT 24`
        )
        .catch(() => []);
      const listHtml = activeProducts
        .map(
          (p) =>
            `<article><a href="/product/${escapeHtmlAttr(String(p.slug))}"><h2>${escapeXml(String(p.name))}</h2></a><p>${escapeXml(String(p.short_description || ''))}</p><span>${escapeXml(formatServerNgn(Number(p.sale_price_kobo ?? p.price_kobo ?? 0)))}</span></article>`
        )
        .join('');
      ssrBodyHtml = `<main class="max-w-6xl mx-auto px-6 py-12"><h1>${escapeXml(
        path === '/shop' ? 'Complete Store Catalog — SELLORA' : String(theme.heroHeadline || 'SELLORA — Commerce without limits.')
      )}</h1><p>${escapeXml(description)}</p><section>${listHtml}</section></main>`;
    } else if (path === '/about' || viewParam === 'about') {
      title = seo.aboutSeoTitle;
      description = seo.aboutSeoDescription;
      canonical = `${base}/about`;
      ssrBodyHtml = `<main class="max-w-4xl mx-auto px-6 py-12"><h1>About SELLORA</h1><p>${escapeXml(String(theme.aboutContent || seo.aboutSeoDescription))}</p></main>`;
    } else if (path === '/faq' || viewParam === 'faq') {
      title = seo.faqSeoTitle;
      description = seo.faqSeoDescription;
      canonical = `${base}/faq`;
      ssrBodyHtml = `<main class="max-w-4xl mx-auto px-6 py-12"><h1>Frequently Asked Questions</h1><p>${escapeXml(seo.faqSeoDescription)}</p></main>`;
    } else if (path === '/contact' || viewParam === 'contact') {
      title = 'Support & Contact — SELLORA';
      canonical = `${base}/contact`;
      ssrBodyHtml = `<main class="max-w-4xl mx-auto px-6 py-12"><h1>Contact & Support</h1><p>Contact SELLORA customer support for order inquiries, Nigerian delivery zones, or payment assistance.</p></main>`;
    } else if (path === '/policies' || viewParam === 'policies') {
      title = 'Shipping, Returns & Store Policies — SELLORA';
      canonical = `${base}/policies`;
      ssrBodyHtml = `<main class="max-w-4xl mx-auto px-6 py-12"><h1>Store Policies</h1><p>${escapeXml(String(theme?.policies?.shipping || ''))}</p><p>${escapeXml(String(theme?.policies?.returns || ''))}</p></main>`;
    } else if (path === '/privacy-policy' || viewParam === 'privacy-policy') {
      title = 'Privacy Policy — SELLORA';
      description = 'How SELLORA collects, stores, and protects customer account, address, order, and payment verification information.';
      canonical = `${base}/privacy-policy`;
      ssrBodyHtml = `<main class="max-w-4xl mx-auto px-6 py-12"><h1>Privacy Policy</h1><p>${escapeXml(String(theme?.policies?.privacy || description))}</p></main>`;
    } else if (path === '/terms' || viewParam === 'terms') {
      title = 'Terms of Service — SELLORA';
      description = 'Terms and conditions governing purchases, Nigerian Naira pricing, bank transfer verification, and delivery on SELLORA.';
      canonical = `${base}/terms`;
      ssrBodyHtml = `<main class="max-w-4xl mx-auto px-6 py-12"><h1>Terms of Service</h1><p>${escapeXml(String(theme?.policies?.terms || description))}</p></main>`;
    }
  }

  const robots =
    isPrivateRoute || status === 404
      ? 'noindex, nofollow'
      : seo.indexingEnabled
        ? 'index, follow'
        : 'noindex, nofollow';

  const absoluteOgImage =
    ogImage && ogImage.startsWith('http')
      ? ogImage
      : ogImage
        ? `${base}${ogImage.startsWith('/') ? '' : '/'}${ogImage}`
        : '';

  const extraHeadTags = [
    `<meta name="robots" content="${escapeHtmlAttr(robots)}" />`,
    `<link rel="canonical" href="${escapeHtmlAttr(canonical)}" />`,
    `<meta property="og:url" content="${escapeHtmlAttr(canonical)}" />`,
    absoluteOgImage ? `<meta property="og:image" content="${escapeHtmlAttr(absoluteOgImage)}" />` : '',
    seo.googleSiteVerification
      ? `<meta name="google-site-verification" content="${escapeHtmlAttr(seo.googleSiteVerification)}" />`
      : '',
  ]
    .filter(Boolean)
    .join('\n    ');

  let updated = html;
  updated = updated.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeXml(title)}</title>`);
  updated = updated.replace(
    /<meta\s+name="description"[^>]*>/i,
    `<meta name="description" content="${escapeHtmlAttr(description)}" />`
  );
  updated = updated.replace(
    /<meta\s+property="og:type"[^>]*>/i,
    `<meta property="og:type" content="${escapeHtmlAttr(ogType)}" />`
  );
  updated = updated.replace(
    /<meta\s+property="og:title"[^>]*>/i,
    `<meta property="og:title" content="${escapeHtmlAttr(title)}" />`
  );
  updated = updated.replace(
    /<meta\s+property="og:description"[^>]*>/i,
    `<meta property="og:description" content="${escapeHtmlAttr(description)}" />`
  );
  updated = updated.replace(
    /<meta\s+name="twitter:title"[^>]*>/i,
    `<meta name="twitter:title" content="${escapeHtmlAttr(title)}" />`
  );
  updated = updated.replace(
    /<meta\s+name="twitter:description"[^>]*>/i,
    `<meta name="twitter:description" content="${escapeHtmlAttr(description)}" />`
  );

  if (jsonLdGraph.length > 0 && !isPrivateRoute && status === 200) {
    const ldJson = JSON.stringify({ '@context': 'https://schema.org', '@graph': jsonLdGraph }).replace(/</g, '\\u003c');
    const ldTag = `<script type="application/ld+json">${ldJson}</script>`;
    if (/<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/i.test(updated)) {
      updated = updated.replace(
        /<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/i,
        ldTag
      );
    } else {
      updated = updated.replace('</head>', `    ${ldTag}\n  </head>`);
    }
  } else if (isPrivateRoute || status === 404) {
    updated = updated.replace(/<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/i, '');
  }

  if (!updated.includes('name="robots"')) {
    updated = updated.replace('</head>', `    ${extraHeadTags}\n  </head>`);
  }

  if (ssrBodyHtml && !isPrivateRoute) {
    updated = updated.replace(
      /<div\s+id=["']root["']\s*>\s*<\/div>/i,
      `<div id="root">${ssrBodyHtml}</div>`
    );
  }

  return { html: updated, status };
}

export async function injectSeoIntoHtml(
  html: string,
  requestUrl: URL,
  db: SelloraDb,
  env: Partial<AppEnvConfig>
): Promise<string> {
  const result = await renderSeoHtmlResponse(html, requestUrl, db, env);
  return result.html;
}
