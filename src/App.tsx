import React, { useEffect, useMemo, useState } from 'react';
import {
  Heart,
  Menu,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { apiFetch, resolveMediaUrl } from './lib/api';
import { syncDocumentSeo } from './lib/seo';
import {
  getAnalyticsConsent,
  resolveGaMeasurementId,
  setAnalyticsConsent,
  trackAddToCart,
  trackBeginCheckout,
  trackPageView,
} from './lib/analytics';
import { formatNgn } from './shared/types';
import { SelloraLogo } from './components/SelloraLogo';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';
import { AuthModal } from './components/AuthModal';
import { ProductDetailView } from './components/ProductDetailView';
import { CheckoutView, type CartItemView } from './components/CheckoutView';
import { TrackOrderView } from './components/TrackOrderView';
import { CustomerAccountView } from './components/CustomerAccountView';
import { StoreInfoViews } from './components/StoreInfoViews';
import { AdminDashboard } from './components/admin/AdminDashboard';

type AppView =
  | 'home'
  | 'shop'
  | 'product'
  | 'checkout'
  | 'track'
  | 'account'
  | 'about'
  | 'contact'
  | 'faq'
  | 'policies'
  | 'privacy-policy'
  | 'terms'
  | 'not_found'
  | 'admin';

export function App() {
  const [view, setView] = useState<AppView>('home');
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [trackOrderParam, setTrackOrderParam] = useState<string>('');

  const [user, setUser] = useState<any>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [capabilities, setCapabilities] = useState<any>({});

  const [storeConfig, setStoreConfig] = useState<any>({
    theme: {},
    seo: {},
    bankTransfer: { configured: false },
    categories: [],
    collections: [],
  });
  const [products, setProducts] = useState<any[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedCollection, setSelectedCollection] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [sortOrder, setSortOrder] = useState('featured');

  // Cart & Wishlist
  const [cartItems, setCartItems] = useState<CartItemView[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  // Modals & UI
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'signup' | 'forgot' | 'reset' | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [authErrorBanner, setAuthErrorBanner] = useState<string | null>(null);
  const [announcementDismissed, setAnnouncementDismissed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [newsletterMsg, setNewsletterMsg] = useState<string | null>(null);
  const [analyticsConsent, setAnalyticsConsentState] = useState(() => getAnalyticsConsent());

  const refreshSession = async () => {
    try {
      const meRes = await apiFetch<any>('/api/me');
      setUser(meRes.user || null);
      setCapabilities(meRes.capabilities || {});
    } catch {
      // ignore
    } finally {
      setSessionLoaded(true);
    }
  };

  const refreshStorefront = async () => {
    const [cfgRes, prodRes] = await Promise.all([
      apiFetch<any>('/api/storefront/config'),
      apiFetch<{ products: any[] }>('/api/products'),
    ]);
    setStoreConfig(cfgRes);
    setProducts(prodRes.products || []);
  };

  const refreshWishlistAndCart = async (activeProducts: any[]) => {
    try {
      const [cartRes, wishRes] = await Promise.all([
        apiFetch<{ items: Array<{ productId: string; variantId: string; quantity: number }> }>('/api/cart'),
        apiFetch<{ items: any[] }>('/api/wishlist'),
      ]);
      setWishlistIds(new Set((wishRes.items || []).map((w) => w.product_id)));

      const hydrated: CartItemView[] = [];
      for (const ci of cartRes.items || []) {
        const prod = activeProducts.find((p) => p.id === ci.productId);
        const variant = prod?.variants?.find((v: any) => v.id === ci.variantId);
        if (prod && variant) {
          hydrated.push({
            productId: prod.id,
            variantId: variant.id,
            productName: prod.name,
            variantName: variant.name,
            sku: variant.sku,
            unitPriceKobo: variant.sale_price_kobo ?? variant.price_kobo ?? prod.price_kobo,
            image: prod.media?.[0],
            quantity: ci.quantity,
            maxStock: prod.track_inventory ? variant.stock_quantity : undefined,
          });
        }
      }
      setCartItems(hydrated);
    } catch {
      // ignore
    }
  };

  const syncRouteFromBrowser = () => {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view') as AppView | null;
    const slug = params.get('product');
    const cat = params.get('category');
    const col = params.get('collection');
    const ord = params.get('order');
    const authErr = params.get('auth_error') || params.get('error');
    const authMode = params.get('auth_mode');

    if (col) setSelectedCollection(col);
    if (cat) setSelectedCategory(cat);
    if (ord) setTrackOrderParam(ord);

    if (path.startsWith('/admin')) {
      setView('admin');
    } else if (path.startsWith('/product/')) {
      setSelectedSlug(decodeURIComponent(path.slice('/product/'.length)));
      setView('product');
    } else if (path.startsWith('/category/')) {
      setSelectedCategory(decodeURIComponent(path.slice('/category/'.length)));
      setView('shop');
    } else if (path === '/shop') {
      setView('shop');
    } else if (path === '/about') {
      setView('about');
    } else if (path === '/contact') {
      setView('contact');
    } else if (path === '/faq') {
      setView('faq');
    } else if (path === '/policies') {
      setView('policies');
    } else if (path === '/privacy-policy') {
      setView('privacy-policy');
    } else if (path === '/terms') {
      setView('terms');
    } else if (path === '/track') {
      setView('track');
    } else if (path === '/checkout') {
      setView('checkout');
    } else if (path === '/account') {
      setView('account');
    } else if (slug) {
      setSelectedSlug(slug);
      setView('product');
    } else if (v) {
      setView(v);
    } else if (path === '/' || path === '') {
      setView('home');
    } else {
      setView('not_found');
    }

    const tokenParam = params.get('token');
    if (authErr) {
      const friendly =
        authErr === 'access_denied' || authErr === 'oauth_cancelled'
          ? 'Google sign-in was cancelled before completion.'
          : 'Google sign-in could not be completed. Please try again or use email and password.';
      setAuthErrorBanner(friendly);
      setAuthModalMode('signin');
    } else if (tokenParam) {
      setResetToken(tokenParam);
      setAuthModalMode('reset');
    }

    if (authErr || authMode || tokenParam) {
      params.delete('auth_error');
      params.delete('error');
      params.delete('error_description');
      params.delete('auth_mode');
      params.delete('token');
      const nextSearch = params.toString();
      window.history.replaceState(
        {},
        '',
        window.location.pathname + (nextSearch ? `?${nextSearch}` : '')
      );
    }
  };

  useEffect(() => {
    syncRouteFromBrowser();
    window.addEventListener('popstate', syncRouteFromBrowser);
    Promise.all([refreshSession(), refreshStorefront()]).finally(() => setLoadingCatalog(false));
    return () => window.removeEventListener('popstate', syncRouteFromBrowser);
  }, []);

  useEffect(() => {
    if (products.length > 0) {
      refreshWishlistAndCart(products);
    }
  }, [user?.id, products.length]);

  const persistCart = (next: CartItemView[]) => {
    setCartItems(next);
    apiFetch('/api/cart', {
      method: 'PUT',
      body: JSON.stringify({
        items: next.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          quantity: i.quantity,
        })),
      }),
    }).catch(() => {});
  };

  const addToCart = (product: any, variant: any, quantity = 1) => {
    const unitPrice = variant.sale_price_kobo ?? variant.price_kobo ?? product.price_kobo;
    const maxStock = product.track_inventory ? Number(variant.stock_quantity || 0) : 99;
    const existingIdx = cartItems.findIndex((i) => i.variantId === variant.id);
    let next: CartItemView[];
    if (existingIdx >= 0) {
      next = [...cartItems];
      const mergedQty = Math.min(maxStock, next[existingIdx].quantity + quantity);
      next[existingIdx] = { ...next[existingIdx], quantity: mergedQty };
    } else {
      next = [
        ...cartItems,
        {
          productId: product.id,
          variantId: variant.id,
          productName: product.name,
          variantName: variant.name,
          sku: variant.sku,
          unitPriceKobo: unitPrice,
          image: product.media?.[0],
          quantity: Math.min(maxStock, quantity),
          maxStock,
        },
      ];
    }
    persistCart(next);
    trackAddToCart({
      productId: product.id,
      name: product.name,
      sku: variant.sku || product.sku,
      variantName: variant.name,
      unitPriceKobo: unitPrice,
      quantity,
    });
    setCartOpen(true);
  };

  const toggleWishlist = async (productId: string, variantId?: string) => {
    if (!user) {
      setAuthModalMode('signin');
      return;
    }
    if (wishlistIds.has(productId)) {
      await apiFetch(`/api/wishlist/${productId}`, { method: 'DELETE' });
      const next = new Set(wishlistIds);
      next.delete(productId);
      setWishlistIds(next);
    } else {
      await apiFetch('/api/wishlist', {
        method: 'POST',
        body: JSON.stringify({ productId, variantId }),
      });
      const next = new Set(wishlistIds);
      next.add(productId);
      setWishlistIds(next);
    }
  };

  const filteredProducts = useMemo(() => {
    let list = [...products];
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.short_description?.toLowerCase().includes(q) ||
          p.sku?.toLowerCase().includes(q)
      );
    }
    if (selectedCategory) {
      list = list.filter((p) => p.category_slug === selectedCategory || p.category_id === selectedCategory);
    }
    if (selectedCollection) {
      list = list.filter((p) => p.collection_slug === selectedCollection || p.collection_id === selectedCollection);
    }
    if (inStockOnly) {
      list = list.filter((p) => !p.track_inventory || p.totalStock > 0);
    }
    if (sortOrder === 'price_asc') {
      list.sort((a, b) => (a.sale_price_kobo ?? a.price_kobo) - (b.sale_price_kobo ?? b.price_kobo));
    } else if (sortOrder === 'price_desc') {
      list.sort((a, b) => (b.sale_price_kobo ?? b.price_kobo) - (a.sale_price_kobo ?? a.price_kobo));
    }
    return list;
  }, [products, searchQuery, selectedCategory, selectedCollection, inStockOnly, sortOrder]);

  const cartCount = cartItems.reduce((s, i) => s + i.quantity, 0);
  const cartSubtotal = cartItems.reduce((s, i) => s + i.unitPriceKobo * i.quantity, 0);
  const theme = storeConfig.theme || {};
  const seoCfg = storeConfig.seo || {};
  const activeGaId = resolveGaMeasurementId(seoCfg.gaMeasurementId);
  const isStaff = Boolean(user && user.role !== 'customer');

  const buildRouteUrl = (
    nextView: AppView,
    opts?: { slug?: string; order?: string; category?: string }
  ): string => {
    if (nextView === 'product' && (opts?.slug || selectedSlug)) {
      return `/product/${encodeURIComponent(opts?.slug || selectedSlug)}`;
    }
    if (nextView === 'shop' && opts?.category) {
      return `/category/${encodeURIComponent(opts.category)}`;
    }
    if (nextView === 'shop') return '/shop';
    if (nextView === 'about') return '/about';
    if (nextView === 'contact') return '/contact';
    if (nextView === 'faq') return '/faq';
    if (nextView === 'policies') return '/policies';
    if (nextView === 'privacy-policy') return '/privacy-policy';
    if (nextView === 'terms') return '/terms';
    if (nextView === 'checkout') return '/checkout';
    if (nextView === 'account') return '/account';
    if (nextView === 'admin') return '/admin';
    if (nextView === 'not_found') return window.location.pathname;
    if (nextView === 'track') {
      const ord = opts?.order ?? trackOrderParam;
      return ord ? `/track?order=${encodeURIComponent(ord)}` : '/track';
    }
    return '/';
  };

  const navigate = (
    nextView: AppView,
    opts?: { slug?: string; order?: string; category?: string }
  ) => {
    if (opts?.slug !== undefined) setSelectedSlug(opts.slug);
    if (opts?.order !== undefined) setTrackOrderParam(opts.order);
    if (opts?.category !== undefined) setSelectedCategory(opts.category);
    setView(nextView);
    setMobileMenuOpen(false);
    const nextUrl = buildRouteUrl(nextView, opts);
    if (window.location.pathname + window.location.search !== nextUrl) {
      window.history.pushState({}, '', nextUrl);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    if (view === 'product') return; // ProductDetailView sets specific product metadata & JSON-LD
    const base = seoCfg.canonicalBaseUrl || undefined;
    const isPrivate = ['admin', 'account', 'checkout', 'track', 'not_found'].includes(view);
    const catObj =
      view === 'shop' && selectedCategory
        ? (storeConfig.categories || []).find((c: any) => c.slug === selectedCategory)
        : null;

    let title = seoCfg.siteTitle || 'SELLORA — Commerce without limits.';
    let description =
      seoCfg.metaDescription ||
      'Shop curated lifestyle essentials, electronics, and leather goods on SELLORA. Priced transparently in NGN.';
    let canonicalPath = '/';
    let breadcrumbs: Array<{ name: string; path: string }> | undefined;

    if (view === 'shop' && catObj) {
      title = catObj.seo_title || `${catObj.name} — SELLORA`;
      description = catObj.seo_description || catObj.description || description;
      canonicalPath = `/category/${encodeURIComponent(catObj.slug)}`;
      breadcrumbs = [
        { name: 'Home', path: '/' },
        { name: catObj.name, path: canonicalPath },
      ];
    } else if (view === 'shop') {
      title = seoCfg.shopSeoTitle || 'Shop All Products — SELLORA';
      description = seoCfg.shopSeoDescription || description;
      canonicalPath = '/shop';
      breadcrumbs = [
        { name: 'Home', path: '/' },
        { name: 'Shop', path: '/shop' },
      ];
    } else if (view === 'about') {
      title = seoCfg.aboutSeoTitle || 'About SELLORA — Commerce without limits.';
      description = seoCfg.aboutSeoDescription || description;
      canonicalPath = '/about';
    } else if (view === 'faq') {
      title = seoCfg.faqSeoTitle || 'Frequently Asked Questions — SELLORA';
      description = seoCfg.faqSeoDescription || description;
      canonicalPath = '/faq';
    } else if (view === 'contact') {
      title = 'Support & Contact — SELLORA';
      canonicalPath = '/contact';
    } else if (view === 'policies') {
      title = 'Shipping, Returns & Store Policies — SELLORA';
      canonicalPath = '/policies';
    } else if (view === 'privacy-policy') {
      title = 'Privacy Policy — SELLORA';
      description = 'How SELLORA protects customer account, order, and payment verification information.';
      canonicalPath = '/privacy-policy';
    } else if (view === 'terms') {
      title = 'Terms of Service — SELLORA';
      description = 'Terms and conditions for shopping and delivery on SELLORA.';
      canonicalPath = '/terms';
    } else if (view === 'not_found') {
      title = 'Page Not Found — SELLORA';
      description = 'The requested page could not be found.';
      canonicalPath = window.location.pathname || '/';
    } else if (view === 'checkout') {
      title = 'Checkout — SELLORA';
      canonicalPath = '/checkout';
    } else if (view === 'track') {
      title = 'Track Order — SELLORA';
      canonicalPath = '/track';
    } else if (view === 'account') {
      title = 'My Account — SELLORA';
      canonicalPath = '/account';
    } else if (view === 'admin') {
      title = 'Store Console — SELLORA';
      canonicalPath = '/admin';
    }

    syncDocumentSeo({
      title,
      description,
      canonicalPath,
      baseUrl: base,
      isPrivate,
      indexingEnabled: seoCfg.indexingEnabled !== false,
      ogImage: seoCfg.defaultOgImage,
      googleSiteVerification: seoCfg.googleSiteVerification,
      faviconUrl: theme.faviconUrl,
      storeName: theme.storeName || 'SELLORA',
      contactEmail: theme.contactEmail,
      contactPhone: theme.contactPhone,
      breadcrumbs,
    });

    if (!isPrivate || view === 'checkout' || view === 'track') {
      trackPageView(canonicalPath, title, seoCfg.gaMeasurementId);
    }
  }, [view, selectedCategory, storeConfig]);

  const effectiveTurnstileSiteKey = capabilities.turnstileEnabled
    ? capabilities.turnstileSiteKey || import.meta.env.VITE_TURNSTILE_SITE_KEY || null
    : null;

  if (view === 'admin') {
    if (!sessionLoaded) {
      return (
        <div className="min-h-screen bg-[#F5F7F4] flex items-center justify-center p-6">
          <div className="text-sm font-semibold text-[#172554]">Verifying administrator session...</div>
        </div>
      );
    }

    if (!user) {
      return (
        <div className="min-h-screen bg-[#F5F7F4] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl bg-white border border-slate-200 shadow-lg p-8 text-center space-y-4">
            <SelloraLogo size="md" className="mx-auto" />
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[#172554]/10 px-3 py-1 text-xs font-bold text-[#172554]">
              <ShieldCheck className="w-3.5 h-3.5" /> Protected Administrator Route
            </div>
            <h1 className="text-xl font-bold text-[#172554]">Administrator Sign-In Required</h1>
            <p className="text-xs text-slate-600 leading-relaxed">
              Sign in with an authorized store owner, administrator, or staff account to access the
              SELLORA Admin Dashboard. Customer accounts cannot enter administrative views.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAuthModalMode('signin')}
                className="flex-1 rounded-lg bg-[#172554] px-4 py-2.5 text-xs font-bold text-[#B7F36B] hover:bg-[#1E3A8A]"
              >
                Sign In to Admin
              </button>
              <button
                type="button"
                onClick={() => {
                  window.history.replaceState({}, '', '/');
                  navigate('home');
                }}
                className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Return to Storefront
              </button>
            </div>
          </div>
          {authModalMode && (
            <AuthModal
              initialMode={authModalMode}
              resetToken={resetToken}
              googleOAuthEnabled={capabilities.googleOAuthEnabled}
              turnstileSiteKey={effectiveTurnstileSiteKey}
              initialError={authErrorBanner}
              onClose={() => {
                setAuthModalMode(null);
                setAuthErrorBanner(null);
              }}
              onSuccess={refreshSession}
            />
          )}
          <OfflineIndicator />
        </div>
      );
    }

    if (!isStaff) {
      return (
        <div className="min-h-screen bg-[#F5F7F4] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl bg-white border border-[#F47B68]/40 shadow-lg p-8 text-center space-y-4">
            <SelloraLogo size="md" className="mx-auto" />
            <div className="text-xs font-bold uppercase tracking-wider text-[#9A2E1E]">
              403 · Access Forbidden
            </div>
            <h1 className="text-xl font-bold text-[#172554]">Access Restricted</h1>
            <p className="text-xs text-slate-600 leading-relaxed">
              You are signed in as <strong>{user.email}</strong>. Store management controls and
              analytics are restricted to authorized store operators.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  window.history.replaceState({}, '', '/');
                  navigate('home');
                }}
                className="flex-1 rounded-lg bg-[#172554] px-4 py-2.5 text-xs font-bold text-[#B7F36B]"
              >
                Return to Storefront
              </button>
              <button
                type="button"
                onClick={() => {
                  window.history.replaceState({}, '', '/?view=account');
                  navigate('account');
                }}
                className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-xs font-semibold text-[#172554]"
              >
                My Customer Account
              </button>
            </div>
          </div>
          <OfflineIndicator />
        </div>
      );
    }

    return (
      <>
        <AdminDashboard
          user={user}
          capabilities={capabilities}
          onExitAdmin={() => {
            window.history.replaceState({}, '', '/');
            navigate('home');
          }}
          onRefreshStorefront={refreshStorefront}
        />
        <OfflineIndicator />
      </>
    );
  }

  // Maintenance mode gate for customers
  if (theme.maintenanceMode && !isStaff && view !== 'track') {
    return (
      <div className="min-h-screen bg-[#172554] text-white flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <SelloraLogo variant="dark" size="lg" className="mx-auto" />
          <h1 className="text-2xl font-bold">Storefront Scheduled Maintenance</h1>
          <p className="text-sm text-slate-300">
            SELLORA is undergoing brief store updates. Existing orders can still be tracked anytime.
          </p>
          <div className="flex justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => navigate('track')}
              className="rounded-lg bg-[#B7F36B] px-4 py-2 text-xs font-bold text-[#172554]"
            >
              Track Order
            </button>
            <button
              type="button"
              onClick={() => setAuthModalMode('signin')}
              className="rounded-lg border border-white/30 px-4 py-2 text-xs font-semibold text-white"
            >
              Staff Sign In
            </button>
          </div>
        </div>
        {authModalMode && (
          <AuthModal
            initialMode={authModalMode}
            resetToken={resetToken}
            googleOAuthEnabled={capabilities.googleOAuthEnabled}
            turnstileSiteKey={effectiveTurnstileSiteKey}
            initialError={authErrorBanner}
            onClose={() => {
              setAuthModalMode(null);
              setAuthErrorBanner(null);
            }}
            onSuccess={refreshSession}
          />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F5F7F4] text-[#1E293B]">
      {/* Slim Dismissible Announcement Bar */}
      {theme.announcementEnabled && !announcementDismissed && (
        <div className="bg-[#172554] text-white text-xs px-4 py-2 flex items-center justify-between gap-4">
          <div className="mx-auto text-center font-medium truncate">
            {theme.announcementText || 'SELLORA — Commerce without limits.'}
          </div>
          <button
            type="button"
            onClick={() => setAnnouncementDismissed(true)}
            className="text-slate-300 hover:text-white shrink-0"
            aria-label="Dismiss announcement"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Clean 3-Zone Top Header */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-xs border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Mark */}
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setSelectedCategory('');
              setSelectedCollection('');
              navigate('home');
            }}
            className="focus-visible:outline-2 focus-visible:outline-[#172554] rounded-lg inline-flex items-center gap-2"
          >
            {theme.logoUrl ? (
              <img
                src={resolveMediaUrl(theme.logoUrl)}
                alt={theme.storeName || 'SELLORA'}
                className="h-8 w-auto object-contain"
              />
            ) : (
              <SelloraLogo size="md" />
            )}
          </a>

          {/* Zone 2: Single-line Nav Links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
            <a
              href="/shop"
              onClick={(e) => {
                e.preventDefault();
                navigate('shop', { category: '' });
              }}
              className={`hover:text-[#172554] transition-colors whitespace-nowrap shrink-0 ${
                view === 'shop' ? 'text-[#172554] font-semibold' : ''
              }`}
            >
              Shop
            </a>
            <a
              href="/track"
              onClick={(e) => {
                e.preventDefault();
                navigate('track');
              }}
              className={`hover:text-[#172554] transition-colors whitespace-nowrap shrink-0 ${
                view === 'track' ? 'text-[#172554] font-semibold' : ''
              }`}
            >
              Track Order
            </a>
            <a
              href="/about"
              onClick={(e) => {
                e.preventDefault();
                navigate('about');
              }}
              className={`hover:text-[#172554] transition-colors whitespace-nowrap shrink-0 ${
                view === 'about' ? 'text-[#172554] font-semibold' : ''
              }`}
            >
              About
            </a>
            <a
              href="/contact"
              onClick={(e) => {
                e.preventDefault();
                navigate('contact');
              }}
              className={`hover:text-[#172554] transition-colors whitespace-nowrap shrink-0 ${
                view === 'contact' ? 'text-[#172554] font-semibold' : ''
              }`}
            >
              Support
            </a>
            {isStaff && (
              <a
                href="/admin"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('admin');
                }}
                className="text-[#172554] font-bold hover:underline whitespace-nowrap shrink-0"
              >
                Store Console
              </a>
            )}
          </nav>

          {/* Zone 3: Compact Actions */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setShowSearchBar((s) => !s)}
              className="p-2 rounded-lg text-slate-600 hover:bg-[#F5F7F4] hover:text-[#172554]"
              aria-label="Search products"
            >
              <Search className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => (user ? navigate('account') : setAuthModalMode('signin'))}
              className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold text-[#172554] hover:bg-[#F5F7F4] whitespace-nowrap shrink-0"
            >
              <User className="w-4 h-4" />
              <span className="hidden sm:inline">{user ? user.name.split(' ')[0] : 'Account'}</span>
            </button>
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#172554] px-3.5 py-2 text-xs font-bold text-[#B7F36B] hover:bg-[#1E3A8A] transition-colors whitespace-nowrap shrink-0"
            >
              <ShoppingBag className="w-4 h-4" />
              <span className="tabular-nums">Bag ({cartCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((m) => !m)}
              className="md:hidden p-2 rounded-lg text-[#172554]"
              aria-label="Toggle menu"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Expandable Search Bar */}
        {showSearchBar && (
          <div className="border-t border-slate-200 bg-white px-4 sm:px-6 py-3">
            <div className="max-w-3xl mx-auto flex gap-2">
              <input
                type="search"
                autoFocus
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (view !== 'shop' && view !== 'home') setView('shop');
                }}
                placeholder="Search products, brands, categories..."
                className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-[#172554] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowSearchBar(false)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Mobile Drawer Nav */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-slate-200 bg-white px-4 py-3 flex flex-col gap-2 text-sm font-medium">
            <button type="button" onClick={() => navigate('shop')} className="py-2 text-left">
              Shop Catalog
            </button>
            <button type="button" onClick={() => navigate('track')} className="py-2 text-left">
              Track Order
            </button>
            <button type="button" onClick={() => navigate('about')} className="py-2 text-left">
              About SELLORA
            </button>
            <button type="button" onClick={() => navigate('contact')} className="py-2 text-left">
              Support
            </button>
            {isStaff && (
              <button
                type="button"
                onClick={() => navigate('admin')}
                className="py-2 text-left font-bold text-[#172554]"
              >
                Store Console
              </button>
            )}
          </div>
        )}
      </header>

      {/* Main Page Content */}
      <main className="flex-1">
        {(view === 'home' || view === 'shop') && (
          <>
            {view === 'home' && (
              <section className="bg-white border-b border-slate-200">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
                  <div className="lg:col-span-5 flex flex-col justify-center space-y-5">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[#64748B]">
                      SELLORA · Commerce without limits
                    </div>
                    <h1 className="text-3xl sm:text-4xl lg:text-[2.75rem] font-extrabold text-[#172554] leading-[1.12] text-balance">
                      {theme.heroHeadline || 'Curated essentials built for modern Nigerian commerce.'}
                    </h1>
                    <p className="text-sm sm:text-base text-slate-600 leading-relaxed max-w-xl">
                      {theme.heroSubtitle ||
                        'Precision audio, structured leather goods, and workspace hardware backed by transparent NGN pricing and verified delivery tracking.'}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 pt-2">
                      <a
                        href="/shop"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate('shop');
                        }}
                        className="rounded-xl bg-[#172554] px-6 py-3.5 text-sm font-bold text-[#B7F36B] hover:bg-[#1E3A8A] transition-colors"
                      >
                        Explore Catalog
                      </a>
                      <a
                        href="/track"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate('track');
                        }}
                        className="rounded-xl border border-slate-300 bg-white px-5 py-3.5 text-sm font-semibold text-[#172554] hover:border-[#172554] transition-colors"
                      >
                        Track an Order
                      </a>
                    </div>
                  </div>

                  <div className="lg:col-span-7">
                    <div className="aspect-[16/9] lg:h-full w-full overflow-hidden rounded-2xl bg-[#172554] border border-slate-200">
                      <img
                        src={resolveMediaUrl(
                          theme.heroImage ||
                            '/src/assets/images/hero_sellora_editorial_1794648058731.jpg'
                        )}
                        alt="SELLORA curated studio collection"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Catalog Section */}
            <section className="max-w-7xl mx-auto px-4 sm:px-6 py-12 space-y-8">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-[#172554]">
                    {view === 'home' ? 'Featured Collection' : 'Complete Store Catalog'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">
                    All prices in Nigerian Naira (NGN) · Live inventory verification
                  </p>
                </div>

                {/* Filter Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg overflow-x-auto">
                    <a
                      href="/shop"
                      onClick={(e) => {
                        e.preventDefault();
                        setSelectedCategory('');
                        if (view === 'shop') {
                          window.history.pushState({}, '', '/shop');
                        }
                      }}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap ${
                        selectedCategory === ''
                          ? 'bg-[#172554] text-[#B7F36B]'
                          : 'text-slate-600 hover:text-[#172554]'
                      }`}
                    >
                      All
                    </a>
                    {(storeConfig.categories || []).map((c: any) => (
                      <a
                        key={c.id}
                        href={`/category/${encodeURIComponent(c.slug)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          setSelectedCategory(c.slug);
                          if (view === 'shop') {
                            window.history.pushState(
                              {},
                              '',
                              `/category/${encodeURIComponent(c.slug)}`
                            );
                          }
                        }}
                        className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap ${
                          selectedCategory === c.slug
                            ? 'bg-[#172554] text-[#B7F36B]'
                            : 'text-slate-600 hover:text-[#172554]'
                        }`}
                      >
                        {c.name}
                      </a>
                    ))}
                  </div>

                  <select
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-[#1E293B]"
                    aria-label="Sort products"
                  >
                    <option value="featured">Featured</option>
                    <option value="price_asc">Price: Low to High</option>
                    <option value="price_desc">Price: High to Low</option>
                    <option value="newest">Newest</option>
                  </select>

                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 px-2">
                    <input
                      type="checkbox"
                      checked={inStockOnly}
                      onChange={(e) => setInStockOnly(e.target.checked)}
                    />
                    In Stock
                  </label>
                </div>
              </div>

              {loadingCatalog ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="rounded-2xl bg-white border border-slate-200 p-4 animate-pulse space-y-3">
                      <div className="aspect-[4/3] bg-slate-200 rounded-xl" />
                      <div className="h-4 bg-slate-200 rounded w-2/3" />
                      <div className="h-4 bg-slate-200 rounded w-1/3" />
                    </div>
                  ))}
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="rounded-2xl bg-white border border-slate-200 p-12 text-center space-y-3">
                  <h3 className="text-base font-bold text-[#172554]">No matching products</h3>
                  <p className="text-xs text-slate-500">
                    Try clearing your search or category filter to explore more items.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredProducts.map((p) => {
                    const primaryVariant = p.variants?.[0];
                    const effectivePrice = p.sale_price_kobo ?? p.price_kobo;
                    const isSale = p.sale_price_kobo !== null && p.sale_price_kobo < p.price_kobo;
                    const outOfStock = p.track_inventory && p.totalStock <= 0;
                    const wishlisted = wishlistIds.has(p.id);

                    return (
                      <article
                        key={p.id}
                        className="group rounded-2xl bg-white border border-slate-200 overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                      >
                        <div className="relative aspect-[4/3] bg-[#F5F7F4] overflow-hidden">
                          <a
                            href={`/product/${encodeURIComponent(p.slug)}`}
                            onClick={(e) => {
                              e.preventDefault();
                              navigate('product', { slug: p.slug });
                            }}
                            className="w-full h-full block"
                          >
                            {p.media?.[0] ? (
                              <img
                                src={resolveMediaUrl(p.media[0])}
                                alt={p.image_alt || p.name}
                                referrerPolicy="no-referrer"
                                loading="lazy"
                                className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
                                {p.name}
                              </div>
                            )}
                          </a>
                          <button
                            type="button"
                            onClick={() => toggleWishlist(p.id, primaryVariant?.id)}
                            aria-label="Save to wishlist"
                            className={`absolute top-3 right-3 p-2 rounded-lg bg-white/90 border border-slate-200 transition-colors ${
                              wishlisted ? 'text-[#F47B68]' : 'text-slate-600 hover:text-[#172554]'
                            }`}
                          >
                            <Heart className={`w-4 h-4 ${wishlisted ? 'fill-current' : ''}`} />
                          </button>
                        </div>

                        <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                          <div>
                            <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mb-1">
                              <span>{p.category_name || 'SELLORA'}</span>
                              <span aria-hidden="true">·</span>
                              <span>{outOfStock ? 'Out of Stock' : 'In Stock'}</span>
                            </div>
                            <a
                              href={`/product/${encodeURIComponent(p.slug)}`}
                              onClick={(e) => {
                                e.preventDefault();
                                navigate('product', { slug: p.slug });
                              }}
                              className="block text-left text-base font-bold text-[#172554] hover:underline line-clamp-1"
                            >
                              {p.name}
                            </a>
                            <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                              {p.short_description}
                            </p>
                          </div>

                          <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
                            <div className="flex items-baseline gap-2">
                              <span className="text-base font-bold text-[#172554] tabular-nums">
                                {formatNgn(effectivePrice)}
                              </span>
                              {isSale && (
                                <span className="text-xs text-slate-400 line-through tabular-nums">
                                  {formatNgn(p.price_kobo)}
                                </span>
                              )}
                            </div>

                            <button
                              type="button"
                              disabled={outOfStock || !primaryVariant}
                              onClick={() => primaryVariant && addToCart(p, primaryVariant, 1)}
                              className="rounded-lg bg-[#172554] px-3.5 py-2 text-xs font-bold text-[#B7F36B] hover:bg-[#1E3A8A] disabled:bg-slate-200 disabled:text-slate-500 transition-colors whitespace-nowrap shrink-0"
                            >
                              {outOfStock ? 'Sold Out' : 'Add to Bag'}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            {view === 'home' && (
              <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-16">
                <div className="rounded-2xl bg-[#172554] text-white p-8 sm:p-10 grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold text-[#B7F36B]">Nigerian Delivery</div>
                    <h3 className="text-base font-bold">State & LGA Rate Precision</h3>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Delivery fees and timelines are calculated directly from configured State and
                      LGA delivery zones with full address snapshots.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold text-[#B7F36B]">Manual Verification</div>
                    <h3 className="text-base font-bold">Protected Bank Transfers</h3>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Upload transfer receipts privately. Every payment is manually verified by
                      authorized staff before dispatch.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold text-[#B7F36B]">Live Order Tracking</div>
                    <h3 className="text-base font-bold">Verified Status Timeline</h3>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Track every stage from Order Placed and Payment Confirmed to Out for Delivery
                      with timestamped audit history.
                    </p>
                  </div>
                </div>
              </section>
            )}
          </>
        )}

        {view === 'product' && (
          <ProductDetailView
            slugOrId={selectedSlug}
            user={user}
            wishlistIds={wishlistIds}
            seoConfig={seoCfg}
            theme={theme}
            onBack={() => navigate('shop', { category: '' })}
            onAddToCart={addToCart}
            onToggleWishlist={toggleWishlist}
            onSelectProduct={(slug) => navigate('product', { slug })}
            onSelectCategory={(category) => navigate('shop', { category })}
            onRequireAuth={() => setAuthModalMode('signin')}
          />
        )}

        {view === 'checkout' && (
          <CheckoutView
            items={cartItems}
            user={user}
            bankTransfer={storeConfig.bankTransfer}
            turnstileSiteKey={effectiveTurnstileSiteKey}
            onBack={() => navigate('shop')}
            onOrderCreated={() => {
              persistCart([]);
              refreshStorefront();
            }}
            onTrackOrder={(ordNum) => navigate('track', { order: ordNum })}
          />
        )}

        {view === 'track' && (
          <TrackOrderView initialOrderNumber={trackOrderParam} user={user} />
        )}

        {view === 'account' &&
          (user ? (
            <CustomerAccountView
              user={user}
              onRefreshUser={refreshSession}
              onSignOut={async () => {
                await apiFetch('/api/auth/sign-out', { method: 'POST', body: '{}' });
                setUser(null);
                navigate('home');
              }}
              onTrackOrder={(ordNum) => navigate('track', { order: ordNum })}
              onSelectProduct={(slug) => navigate('product', { slug })}
            />
          ) : (
            <div className="max-w-md mx-auto px-4 py-16 text-center space-y-4">
              <h2 className="text-xl font-bold text-[#172554]">Sign in to access your account</h2>
              <button
                type="button"
                onClick={() => setAuthModalMode('signin')}
                className="rounded-lg bg-[#172554] px-5 py-2.5 text-sm font-bold text-[#B7F36B]"
              >
                Sign In / Register
              </button>
            </div>
          ))}

        {(view === 'about' ||
          view === 'contact' ||
          view === 'faq' ||
          view === 'policies' ||
          view === 'privacy-policy' ||
          view === 'terms') && <StoreInfoViews section={view} theme={theme} user={user} />}

        {view === 'not_found' && (
          <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4">
            <div className="text-xs font-bold uppercase tracking-widest text-[#64748B]">404</div>
            <h1 className="text-2xl font-bold text-[#172554]">Page Not Found</h1>
            <p className="text-sm text-slate-600">
              The storefront page you requested could not be found or may have moved.
            </p>
            <div className="flex justify-center gap-3 pt-2">
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('home');
                }}
                className="rounded-lg bg-[#172554] px-5 py-2.5 text-xs font-bold text-[#B7F36B]"
              >
                Return Home
              </a>
              <a
                href="/shop"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('shop');
                }}
                className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-xs font-semibold text-[#172554]"
              >
                Browse Catalog
              </a>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-[#172554] text-white border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 grid grid-cols-1 md:grid-cols-12 gap-8">
          <div className="md:col-span-4 space-y-3">
            <SelloraLogo variant="dark" size="md" />
            <p className="text-xs text-slate-300 leading-relaxed max-w-xs">
              Commerce without limits. Single-store Nigerian retail platform operating in NGN with
              Africa/Lagos time precision.
            </p>
            <div className="pt-1">
              <PWAInstallButton />
            </div>
          </div>

          <div className="md:col-span-2 space-y-2 text-xs">
            <div className="font-bold text-[#B7F36B]">Store</div>
            <div className="flex flex-col gap-1.5 text-slate-300">
              <a
                href="/shop"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('shop', { category: '' });
                }}
                className="text-left hover:text-white"
              >
                All Products
              </a>
              <a
                href="/track"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('track');
                }}
                className="text-left hover:text-white"
              >
                Track Order
              </a>
              <a
                href="/about"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('about');
                }}
                className="text-left hover:text-white"
              >
                About Us
              </a>
            </div>
          </div>

          <div className="md:col-span-2 space-y-2 text-xs">
            <div className="font-bold text-[#B7F36B]">Help & Policies</div>
            <div className="flex flex-col gap-1.5 text-slate-300">
              <a
                href="/contact"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('contact');
                }}
                className="text-left hover:text-white"
              >
                Contact Support
              </a>
              <a
                href="/faq"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('faq');
                }}
                className="text-left hover:text-white"
              >
                FAQ
              </a>
              <a
                href="/policies"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('policies');
                }}
                className="text-left hover:text-white"
              >
                Store Policies
              </a>
              <a
                href="/privacy-policy"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('privacy-policy');
                }}
                className="text-left hover:text-white"
              >
                Privacy Policy
              </a>
              <a
                href="/terms"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('terms');
                }}
                className="text-left hover:text-white"
              >
                Terms of Service
              </a>
            </div>
          </div>

          <div className="md:col-span-4 space-y-2.5 text-xs">
            <div className="font-bold text-[#B7F36B]">Newsletter</div>
            <p className="text-slate-300">Receive new product arrivals and store announcements.</p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await apiFetch('/api/newsletter', {
                  method: 'POST',
                  body: JSON.stringify({ email: newsletterEmail }),
                });
                setNewsletterEmail('');
                setNewsletterMsg('Subscribed to SELLORA updates.');
              }}
              className="flex gap-2"
            >
              <input
                type="email"
                required
                value={newsletterEmail}
                onChange={(e) => setNewsletterEmail(e.target.value)}
                placeholder="you@example.com"
                className="flex-1 rounded-lg bg-white/10 border border-white/20 px-3 py-2 text-xs text-white placeholder:text-slate-400 focus:outline-none focus:border-[#B7F36B]"
              />
              <button
                type="submit"
                className="rounded-lg bg-[#B7F36B] px-4 py-2 text-xs font-bold text-[#172554]"
              >
                Join
              </button>
            </form>
            {newsletterMsg && <p className="text-[#B7F36B]">{newsletterMsg}</p>}
          </div>
        </div>
        <div className="border-t border-white/10 px-4 sm:px-6 py-4 text-center text-[11px] text-slate-400">
          © {new Date().getFullYear()} SELLORA. All rights reserved. Currency: NGN · Timezone: Africa/Lagos.
        </div>
      </footer>

      {/* Slide-over Cart Drawer */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white h-full flex flex-col shadow-2xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-base font-bold text-[#172554]">Shopping Bag ({cartCount})</h2>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close bag"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {cartItems.length === 0 ? (
                <div className="py-16 text-center text-sm text-slate-500">
                  Your shopping bag is currently empty.
                </div>
              ) : (
                cartItems.map((item) => (
                  <div
                    key={item.variantId}
                    className="flex gap-4 border-b border-slate-100 pb-4"
                  >
                    <div className="w-20 h-16 rounded-lg bg-[#F5F7F4] overflow-hidden shrink-0">
                      {item.image && (
                        <img
                          src={resolveMediaUrl(item.image)}
                          alt={item.productName}
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-[#172554] truncate">
                        {item.productName}
                      </div>
                      <div className="text-xs text-slate-500">{item.variantName}</div>
                      <div className="text-xs font-bold text-[#172554] tabular-nums mt-1">
                        {formatNgn(item.unitPriceKobo)}
                      </div>
                      <div className="flex items-center justify-between mt-2">
                        <div className="inline-flex items-center rounded border border-slate-300">
                          <button
                            type="button"
                            onClick={() => {
                              const next = cartItems
                                .map((c) =>
                                  c.variantId === item.variantId
                                    ? { ...c, quantity: c.quantity - 1 }
                                    : c
                                )
                                .filter((c) => c.quantity > 0);
                              persistCart(next);
                            }}
                            className="p-1 text-slate-600"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="px-2.5 text-xs font-semibold tabular-nums">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const next = cartItems.map((c) =>
                                c.variantId === item.variantId
                                  ? {
                                      ...c,
                                      quantity: item.maxStock
                                        ? Math.min(item.maxStock, c.quantity + 1)
                                        : c.quantity + 1,
                                    }
                                  : c
                              );
                              persistCart(next);
                            }}
                            className="p-1 text-slate-600"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            persistCart(cartItems.filter((c) => c.variantId !== item.variantId))
                          }
                          className="text-slate-400 hover:text-[#F47B68]"
                          aria-label="Remove item"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {cartItems.length > 0 && (
              <div className="p-6 border-t border-slate-200 bg-[#F5F7F4] space-y-4">
                <div className="flex justify-between text-sm font-bold text-[#172554]">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{formatNgn(cartSubtotal)}</span>
                </div>
                <p className="text-[11px] text-slate-500">
                  Delivery fee calculated from your Nigerian State & LGA at checkout.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    trackBeginCheckout(cartItems, cartSubtotal);
                    setCartOpen(false);
                    navigate('checkout');
                  }}
                  className="w-full rounded-xl bg-[#172554] px-5 py-3 text-sm font-bold text-[#B7F36B] hover:bg-[#1E3A8A]"
                >
                  Proceed to Checkout
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {authModalMode && (
        <AuthModal
          initialMode={authModalMode}
          resetToken={resetToken}
          googleOAuthEnabled={capabilities.googleOAuthEnabled}
          turnstileSiteKey={effectiveTurnstileSiteKey}
          initialError={authErrorBanner}
          onClose={() => {
            setAuthModalMode(null);
            setAuthErrorBanner(null);
          }}
          onSuccess={refreshSession}
        />
      )}

      {activeGaId && analyticsConsent === null && (
        <div className="fixed bottom-4 right-4 z-40 max-w-sm rounded-xl bg-[#172554] text-white border border-white/15 shadow-lg p-4 text-xs space-y-2.5">
          <p className="text-slate-200 leading-relaxed">
            SELLORA uses privacy-safe storefront analytics to improve shopping performance.
            Personal emails and payment receipts are never shared.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAnalyticsConsent('denied', activeGaId);
                setAnalyticsConsentState('denied');
              }}
              className="rounded-lg border border-white/25 px-3 py-1.5 text-slate-200 hover:bg-white/10"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => {
                setAnalyticsConsent('granted', activeGaId);
                setAnalyticsConsentState('granted');
              }}
              className="rounded-lg bg-[#B7F36B] px-3 py-1.5 font-bold text-[#172554]"
            >
              Allow Analytics
            </button>
          </div>
        </div>
      )}

      <OfflineIndicator />
    </div>
  );
}

export default App;
