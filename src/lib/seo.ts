export interface SeoInput {
  title: string;
  description: string;
  canonicalPath: string;
  baseUrl?: string;
  isPrivate?: boolean;
  indexingEnabled?: boolean;
  ogType?: 'website' | 'product';
  ogImage?: string;
  googleSiteVerification?: string;
  faviconUrl?: string;
  storeName?: string;
  contactEmail?: string;
  contactPhone?: string;
  productSchema?: {
    name: string;
    description: string;
    sku: string;
    slug: string;
    priceNaira: number;
    inStock: boolean;
    image?: string;
    brand?: string;
    categoryName?: string;
    categorySlug?: string;
    ratingValue?: number | null;
    reviewCount?: number;
  };
  breadcrumbs?: Array<{ name: string; path: string }>;
}

function setMetaTag(selector: string, attrName: 'name' | 'property', attrVal: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!content) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attrName, attrVal);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setCanonicalLink(href: string) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

function toAbsoluteUrl(urlOrPath: string, origin: string): string {
  if (!urlOrPath) return '';
  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) return urlOrPath;
  return `${origin}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;
}

export function syncDocumentSeo(input: SeoInput): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const origin = (input.baseUrl || window.location.origin).replace(/\/+$/, '');
  const cleanPath = input.canonicalPath.startsWith('/') ? input.canonicalPath : `/${input.canonicalPath}`;
  const canonicalUrl = `${origin}${cleanPath}`;
  const ogImageAbs = toAbsoluteUrl(
    input.ogImage || '/src/assets/images/hero_sellora_editorial_1794648058731.jpg',
    origin
  );

  const robotsContent =
    input.isPrivate || input.indexingEnabled === false ? 'noindex, nofollow' : 'index, follow';

  document.title = input.title;
  setMetaTag('meta[name="description"]', 'name', 'description', input.description);
  setMetaTag('meta[name="robots"]', 'name', 'robots', robotsContent);
  setCanonicalLink(canonicalUrl);

  setMetaTag(
    'meta[name="google-site-verification"]',
    'name',
    'google-site-verification',
    (input.googleSiteVerification || '').trim()
  );

  setMetaTag('meta[property="og:type"]', 'property', 'og:type', input.ogType || 'website');
  setMetaTag('meta[property="og:site_name"]', 'property', 'og:site_name', input.storeName || 'SELLORA');
  setMetaTag('meta[property="og:title"]', 'property', 'og:title', input.title);
  setMetaTag('meta[property="og:description"]', 'property', 'og:description', input.description);
  setMetaTag('meta[property="og:url"]', 'property', 'og:url', canonicalUrl);
  if (ogImageAbs) {
    setMetaTag('meta[property="og:image"]', 'property', 'og:image', ogImageAbs);
  }

  setMetaTag('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary_large_image');
  setMetaTag('meta[name="twitter:title"]', 'name', 'twitter:title', input.title);
  setMetaTag('meta[name="twitter:description"]', 'name', 'twitter:description', input.description);

  if (input.faviconUrl) {
    let icon = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      document.head.appendChild(icon);
    }
    icon.href = input.faviconUrl;
  }

  // Structured Data (JSON-LD) for Search Engines
  const existingLd = document.getElementById('sellora-jsonld');
  if (input.isPrivate) {
    if (existingLd) existingLd.remove();
    return;
  }

  const graph: Record<string, unknown>[] = [
    {
      '@type': 'Store',
      name: input.storeName || 'SELLORA',
      description: 'Commerce without limits. Curated Nigerian ecommerce store priced in NGN.',
      url: origin,
      currenciesAccepted: 'NGN',
      ...(input.contactEmail ? { email: input.contactEmail } : {}),
      ...(input.contactPhone ? { telephone: input.contactPhone } : {}),
    },
    {
      '@type': 'WebSite',
      name: input.storeName || 'SELLORA',
      url: origin,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${origin}/shop?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
  ];

  if (input.productSchema) {
    const ps = input.productSchema;
    const prodLd: Record<string, unknown> = {
      '@type': 'Product',
      name: ps.name,
      description: ps.description,
      sku: ps.sku,
      url: `${origin}/product/${encodeURIComponent(ps.slug)}`,
      brand: {
        '@type': 'Brand',
        name: ps.brand || 'SELLORA',
      },
      ...(ps.image ? { image: [toAbsoluteUrl(ps.image, origin)] } : {}),
      offers: {
        '@type': 'Offer',
        priceCurrency: 'NGN',
        price: ps.priceNaira.toFixed(2),
        availability: ps.inStock
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock',
        url: `${origin}/product/${encodeURIComponent(ps.slug)}`,
      },
    };
    if (ps.ratingValue && ps.reviewCount && ps.reviewCount > 0) {
      prodLd.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: ps.ratingValue,
        reviewCount: ps.reviewCount,
      };
    }
    graph.push(prodLd);
  }

  if (input.breadcrumbs && input.breadcrumbs.length > 0) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: input.breadcrumbs.map((b, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        name: b.name,
        item: `${origin}${b.path.startsWith('/') ? b.path : `/${b.path}`}`,
      })),
    });
  }

  const scriptEl = existingLd || document.createElement('script');
  scriptEl.id = 'sellora-jsonld';
  scriptEl.setAttribute('type', 'application/ld+json');
  scriptEl.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': graph,
  });
  if (!existingLd) {
    document.head.appendChild(scriptEl);
  }
}
