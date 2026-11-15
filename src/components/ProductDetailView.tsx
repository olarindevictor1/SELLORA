import React, { useEffect, useState } from 'react';
import { ArrowLeft, Heart, Minus, Plus, ShieldCheck, Star, Truck } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { syncDocumentSeo } from '../lib/seo';
import { trackProductView } from '../lib/analytics';
import { formatLagosDate, formatNgn } from '../shared/types';
import { NIGERIAN_STATES_LGAS, getLgasForState } from '../shared/nigeria-locations';

interface ProductDetailProps {
  slugOrId: string;
  user: any;
  wishlistIds: Set<string>;
  seoConfig?: any;
  theme?: any;
  onBack: () => void;
  onAddToCart: (product: any, variant: any, quantity: number) => void;
  onToggleWishlist: (productId: string, variantId?: string) => void;
  onSelectProduct: (slug: string) => void;
  onSelectCategory?: (categorySlug: string) => void;
  onRequireAuth: () => void;
}

export const ProductDetailView: React.FC<ProductDetailProps> = ({
  slugOrId,
  user,
  wishlistIds,
  seoConfig,
  theme,
  onBack,
  onAddToCart,
  onToggleWishlist,
  onSelectProduct,
  onSelectCategory,
  onRequireAuth,
}) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedVariantId, setSelectedVariantId] = useState<string>('');
  const [quantity, setQuantity] = useState(1);
  const [activeImg, setActiveImg] = useState(0);

  // Delivery Estimator
  const [estState, setEstState] = useState('Lagos');
  const [estLga, setEstLga] = useState('Ikeja');
  const [estQuote, setEstQuote] = useState<any>(null);

  // Reviews & Q&A
  const [revRating, setRevRating] = useState(5);
  const [revTitle, setRevTitle] = useState('');
  const [revBody, setRevBody] = useState('');
  const [revMsg, setRevMsg] = useState<string | null>(null);
  const [questionText, setQuestionText] = useState('');
  const [guestName, setGuestName] = useState('');
  const [qMsg, setQMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiFetch(`/api/products/${encodeURIComponent(slugOrId)}`)
      .then((res) => {
        if (!active) return;
        setData(res);
        setSelectedVariantId(res.product?.variants?.[0]?.id || '');
        setQuantity(1);
        setActiveImg(0);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [slugOrId]);

  const product = data?.product;
  const variants: any[] = product?.variants || [];
  const selectedVariant = variants.find((v) => v.id === selectedVariantId) || variants[0];

  const unitPrice =
    selectedVariant?.sale_price_kobo ??
    selectedVariant?.price_kobo ??
    product?.sale_price_kobo ??
    product?.price_kobo ??
    0;
  const regularPrice = selectedVariant?.price_kobo ?? product?.price_kobo ?? 0;
  const isOnSale = unitPrice < regularPrice;
  const stockQty = Number(selectedVariant?.stock_quantity ?? 0);
  const inStock = !product?.track_inventory || stockQty > 0;

  useEffect(() => {
    if (!product) return;
    const avgRating =
      data?.reviews?.length > 0
        ? Number(
            (
              data.reviews.reduce((sum: number, r: any) => sum + Number(r.rating || 0), 0) /
              data.reviews.length
            ).toFixed(1)
          )
        : null;
    const primaryImage = product.seo_image_url || product.media?.[0] || seoConfig?.defaultOgImage;
    const canonicalPath = `/product/${encodeURIComponent(product.slug)}`;
    const breadcrumbs = [
      { name: 'Home', path: '/' },
      ...(product.category_slug && product.category_name
        ? [{ name: product.category_name, path: `/category/${encodeURIComponent(product.category_slug)}` }]
        : [{ name: 'Shop', path: '/shop' }]),
      { name: product.name, path: canonicalPath },
    ];

    syncDocumentSeo({
      title: product.seo_title || `${product.name} — SELLORA`,
      description:
        product.seo_description ||
        product.short_description ||
        seoConfig?.metaDescription ||
        'Shop quality essentials on SELLORA.',
      canonicalPath: product.seo_canonical_url
        ? product.seo_canonical_url.replace(/^https?:\/\/[^/]+/, '') || canonicalPath
        : canonicalPath,
      baseUrl: seoConfig?.canonicalBaseUrl || undefined,
      indexingEnabled: seoConfig?.indexingEnabled !== false,
      ogType: 'product',
      ogImage: primaryImage,
      googleSiteVerification: seoConfig?.googleSiteVerification,
      faviconUrl: theme?.faviconUrl,
      contactEmail: theme?.contactEmail,
      contactPhone: theme?.contactPhone,
      productSchema: {
        name: product.name,
        description: product.short_description || product.description || product.name,
        sku: selectedVariant?.sku || product.sku,
        slug: product.slug,
        priceNaira: Number((unitPrice / 100).toFixed(2)),
        inStock,
        image: primaryImage,
        brand: product.brand || 'SELLORA',
        categoryName: product.category_name,
        categorySlug: product.category_slug,
        ratingValue: avgRating,
        reviewCount: data?.reviews?.length || 0,
      },
      breadcrumbs,
    });

    trackProductView({
      id: product.id,
      name: product.name,
      sku: selectedVariant?.sku || product.sku,
      category_name: product.category_name,
      priceKobo: unitPrice,
      slug: product.slug,
    });
  }, [product?.id]);

  useEffect(() => {
    if (!product || !estState || !estLga) return;
    apiFetch('/api/delivery/quote', {
      method: 'POST',
      body: JSON.stringify({ state: estState, lga: estLga, subtotalKobo: unitPrice * quantity }),
    })
      .then(setEstQuote)
      .catch(() => setEstQuote(null));
  }, [product?.id, estState, estLga, unitPrice, quantity]);

  const submitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      onRequireAuth();
      return;
    }
    setRevMsg(null);
    try {
      await apiFetch(`/api/products/${product.id}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ rating: revRating, title: revTitle, body: revBody }),
      });
      setRevTitle('');
      setRevBody('');
      setRevMsg('Review submitted for administrator moderation.');
    } catch (err) {
      setRevMsg(err instanceof Error ? err.message : 'Unable to submit review.');
    }
  };

  const submitQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    setQMsg(null);
    try {
      await apiFetch(`/api/products/${product.id}/questions`, {
        method: 'POST',
        body: JSON.stringify({
          customerName: user?.name || guestName,
          question: questionText,
        }),
      });
      setQuestionText('');
      setQMsg('Your question has been submitted to our store team.');
    } catch (err) {
      setQMsg(err instanceof Error ? err.message : 'Unable to submit question.');
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 animate-pulse">
          <div className="aspect-[4/3] rounded-2xl bg-slate-200" />
          <div className="space-y-4">
            <div className="h-8 bg-slate-200 rounded w-2/3" />
            <div className="h-6 bg-slate-200 rounded w-1/3" />
            <div className="h-24 bg-slate-200 rounded w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <h2 className="text-xl font-bold text-[#172554]">Product not found</h2>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#172554] px-4 py-2 text-sm font-semibold text-[#B7F36B]"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Store
        </button>
      </div>
    );
  }

  const media: string[] = product.media?.length ? product.media : [];
  const wishlisted = wishlistIds.has(product.id);
  const lgas = getLgasForState(estState);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
        <a
          href="/shop"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-[#172554]"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Catalog
        </a>
        <nav aria-label="Breadcrumb" className="text-xs text-slate-500 flex items-center gap-1.5">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
            className="hover:text-[#172554]"
          >
            Home
          </a>
          <span>/</span>
          {product.category_slug && product.category_name && onSelectCategory ? (
            <a
              href={`/category/${encodeURIComponent(product.category_slug)}`}
              onClick={(e) => {
                e.preventDefault();
                onSelectCategory(product.category_slug);
              }}
              className="hover:text-[#172554]"
            >
              {product.category_name}
            </a>
          ) : (
            <a
              href="/shop"
              onClick={(e) => {
                e.preventDefault();
                onBack();
              }}
              className="hover:text-[#172554]"
            >
              Shop
            </a>
          )}
          <span>/</span>
          <span className="text-[#172554] font-semibold truncate max-w-[200px]">{product.name}</span>
        </nav>
      </div>

      {/* Main Sticky Split Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        {/* Left Gallery */}
        <div className="lg:col-span-7 space-y-4 lg:sticky lg:top-24">
          <div className="aspect-[4/3] w-full overflow-hidden rounded-2xl bg-white border border-slate-200">
            {media[activeImg] ? (
              <img
                src={media[activeImg]}
                alt={product.image_alt || product.name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-[#F5F7F4] text-slate-400 text-sm">
                {product.name}
              </div>
            )}
          </div>
          {media.length > 1 && (
            <div className="flex gap-3 overflow-x-auto">
              {media.map((src, idx) => (
                <button
                  key={src + idx}
                  type="button"
                  onClick={() => setActiveImg(idx)}
                  className={`w-20 h-16 rounded-lg overflow-hidden border-2 transition-colors shrink-0 ${
                    activeImg === idx ? 'border-[#172554]' : 'border-slate-200'
                  }`}
                >
                  <img
                    src={src}
                    alt={`${product.image_alt || product.name} view ${idx + 1}`}
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Contiguous Purchase Module */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
              <span>{product.category_name || 'SELLORA Store'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">SKU {selectedVariant?.sku || product.sku}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#172554] text-balance">
              {product.name}
            </h1>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="text-2xl font-bold text-[#172554] tabular-nums">
                {formatNgn(unitPrice)}
              </span>
              {isOnSale && (
                <span className="text-sm text-slate-400 line-through tabular-nums">
                  {formatNgn(regularPrice)}
                </span>
              )}
            </div>
            <p className="mt-3 text-sm text-slate-600 leading-relaxed">
              {product.short_description}
            </p>
          </div>

          {/* Variants */}
          {variants.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-[#1E293B] mb-2">Select Option</div>
              <div className="flex flex-wrap gap-2">
                {variants.map((v) => {
                  const selected = v.id === selectedVariant?.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => {
                        setSelectedVariantId(v.id);
                        setQuantity(1);
                      }}
                      className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                        selected
                          ? 'bg-[#172554] text-[#B7F36B] border-[#172554]'
                          : 'bg-white text-[#1E293B] border-slate-300 hover:border-[#172554]'
                      }`}
                    >
                      {v.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Availability & Quantity */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <div className="text-xs font-semibold">
              {inStock ? (
                <span className="text-emerald-700">
                  In Stock {product.track_inventory ? `(${stockQty} available)` : ''}
                </span>
              ) : (
                <span className="text-[#F47B68]">Out of Stock</span>
              )}
            </div>
            <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white">
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                disabled={quantity <= 1}
                className="p-2 text-slate-600 hover:text-[#172554] disabled:opacity-40"
                aria-label="Decrease quantity"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <span className="px-3 text-sm font-semibold tabular-nums">{quantity}</span>
              <button
                type="button"
                onClick={() =>
                  setQuantity((q) =>
                    product.track_inventory ? Math.min(stockQty, q + 1) : q + 1
                  )
                }
                disabled={!inStock || (product.track_inventory && quantity >= stockQty)}
                className="p-2 text-slate-600 hover:text-[#172554] disabled:opacity-40"
                aria-label="Increase quantity"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Primary Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!inStock || !selectedVariant}
              onClick={() => onAddToCart(product, selectedVariant, quantity)}
              className="flex-1 rounded-xl bg-[#172554] px-5 py-3.5 text-sm font-bold text-[#B7F36B] hover:bg-[#1E3A8A] disabled:bg-slate-200 disabled:text-slate-500 transition-colors"
            >
              {inStock ? 'Add to Bag' : 'Currently Unavailable'}
            </button>
            <button
              type="button"
              onClick={() => onToggleWishlist(product.id, selectedVariant?.id)}
              aria-label="Toggle wishlist"
              className={`rounded-xl border px-4 py-3.5 transition-colors ${
                wishlisted
                  ? 'border-[#F47B68] bg-[#F47B68]/10 text-[#F47B68]'
                  : 'border-slate-300 text-slate-600 hover:border-[#172554] hover:text-[#172554]'
              }`}
            >
              <Heart className={`w-5 h-5 ${wishlisted ? 'fill-current' : ''}`} />
            </button>
          </div>

          {/* Nigerian Delivery Estimator */}
          <div className="rounded-xl bg-[#F5F7F4] border border-slate-200 p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-[#172554]">
              <Truck className="w-4 h-4" />
              <span>Nigerian Delivery & Return Estimate</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={estState}
                onChange={(e) => {
                  const s = e.target.value;
                  setEstState(s);
                  setEstLga(getLgasForState(s)[0] || '*');
                }}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                {NIGERIAN_STATES_LGAS.map((s) => (
                  <option key={s.state} value={s.state}>
                    {s.state}
                  </option>
                ))}
              </select>
              <select
                value={estLga}
                onChange={(e) => setEstLga(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                {lgas.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            {estQuote && (
              <p className="text-xs text-slate-600">
                {estQuote.available ? (
                  <>
                    Delivery fee: <strong className="text-[#172554]">{formatNgn(estQuote.feeKobo)}</strong>{' '}
                    · Est. {estQuote.estimatedDaysMin}–{estQuote.estimatedDaysMax} business days
                  </>
                ) : (
                  <span className="text-[#9A2E1E]">{estQuote.reason}</span>
                )}
              </p>
            )}
            <div className="flex items-center gap-2 text-[11px] text-slate-500 pt-1 border-t border-slate-200">
              <ShieldCheck className="w-3.5 h-3.5 text-[#172554]" />
              <span>7-day return review on unused items · Manual transfer verified before dispatch</span>
            </div>
          </div>
        </div>
      </div>

      {/* Description & Specifications */}
      <div className="mt-14 grid grid-cols-1 lg:grid-cols-12 gap-10 border-t border-slate-200 pt-10">
        <div className="lg:col-span-7 space-y-4">
          <h2 className="text-xl font-bold text-[#172554]">Product Overview</h2>
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
            {product.description || product.short_description}
          </p>
        </div>
        <div className="lg:col-span-5">
          <h2 className="text-xl font-bold text-[#172554] mb-4">Specifications</h2>
          {product.specifications?.length > 0 ? (
            <dl className="divide-y divide-slate-200 border-y border-slate-200">
              {product.specifications.map((s: any, i: number) => (
                <div key={i} className="py-2.5 flex justify-between gap-4 text-sm">
                  <dt className="text-slate-500">{s.label}</dt>
                  <dd className="font-medium text-[#1E293B] text-right">{s.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No additional specifications listed.</p>
          )}
        </div>
      </div>

      {/* Verified Reviews & Questions */}
      <div className="mt-14 grid grid-cols-1 lg:grid-cols-2 gap-10 border-t border-slate-200 pt-10">
        <div className="space-y-5">
          <h2 className="text-xl font-bold text-[#172554]">
            Customer Reviews ({data.reviews?.length || 0})
          </h2>
          {data.reviews?.length === 0 ? (
            <p className="text-sm text-slate-500">No approved reviews yet for this product.</p>
          ) : (
            <div className="space-y-4">
              {data.reviews.map((r: any) => (
                <div key={r.id} className="rounded-xl bg-white border border-slate-200 p-4 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-semibold text-[#1E293B]">
                      {r.customer_name}
                      {r.is_verified_purchase ? ' · Verified Purchase' : ''}
                    </span>
                    <span>{formatLagosDate(r.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-1 text-[#172554]">
                    {Array.from({ length: r.rating }).map((_, idx) => (
                      <Star key={idx} className="w-3.5 h-3.5 fill-[#B7F36B] text-[#172554]" />
                    ))}
                    {r.title && <span className="ml-2 text-sm font-semibold">{r.title}</span>}
                  </div>
                  <p className="text-sm text-slate-600">{r.body}</p>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={submitReview} className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
            <h3 className="text-sm font-bold text-[#172554]">Write a Review</h3>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-600">Rating:</label>
              <select
                value={revRating}
                onChange={(e) => setRevRating(Number(e.target.value))}
                className="rounded border border-slate-300 px-2 py-1 text-xs"
              >
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n} Stars
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={revTitle}
              onChange={(e) => setRevTitle(e.target.value)}
              placeholder="Review headline"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <textarea
              required
              rows={3}
              value={revBody}
              onChange={(e) => setRevBody(e.target.value)}
              placeholder="Share your experience with this item..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            {revMsg && <p className="text-xs text-[#172554] font-medium">{revMsg}</p>}
            <button
              type="submit"
              className="rounded-lg bg-[#172554] px-4 py-2 text-xs font-semibold text-[#B7F36B]"
            >
              Submit Review
            </button>
          </form>
        </div>

        <div className="space-y-5">
          <h2 className="text-xl font-bold text-[#172554]">
            Questions & Answers ({data.questions?.length || 0})
          </h2>
          {data.questions?.length === 0 ? (
            <p className="text-sm text-slate-500">No answered questions yet.</p>
          ) : (
            <div className="space-y-3">
              {data.questions.map((q: any) => (
                <div key={q.id} className="rounded-xl bg-white border border-slate-200 p-4 space-y-2">
                  <p className="text-sm font-semibold text-[#172554]">Q: {q.question}</p>
                  <p className="text-sm text-slate-600">A: {q.answer}</p>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={submitQuestion} className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
            <h3 className="text-sm font-bold text-[#172554]">Ask a Question</h3>
            {!user && (
              <input
                type="text"
                required
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Your name"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            )}
            <textarea
              required
              rows={2}
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder="Ask about sizing, compatibility, or delivery..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            {qMsg && <p className="text-xs text-[#172554] font-medium">{qMsg}</p>}
            <button
              type="submit"
              className="rounded-lg border border-[#172554] px-4 py-2 text-xs font-semibold text-[#172554] hover:bg-[#172554] hover:text-[#B7F36B] transition-colors"
            >
              Submit Question
            </button>
          </form>
        </div>
      </div>

      {/* Related Products */}
      {data.related?.length > 0 && (
        <div className="mt-14 border-t border-slate-200 pt-10">
          <h2 className="text-xl font-bold text-[#172554] mb-6">Related Essentials</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {data.related.map((r: any) => (
              <a
                key={r.id}
                href={`/product/${encodeURIComponent(r.slug)}`}
                onClick={(e) => {
                  e.preventDefault();
                  onSelectProduct(r.slug);
                }}
                className="text-left group rounded-xl bg-white border border-slate-200 overflow-hidden hover:shadow-md transition-all block"
              >
                <div className="aspect-[4/3] bg-[#F5F7F4] overflow-hidden">
                  {r.media?.[0] && (
                    <img
                      src={r.media[0]}
                      alt={r.name}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
                    />
                  )}
                </div>
                <div className="p-4">
                  <div className="text-sm font-semibold text-[#172554] truncate">{r.name}</div>
                  <div className="text-sm font-bold text-slate-700 mt-1 tabular-nums">
                    {formatNgn(r.sale_price_kobo ?? r.price_kobo)}
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
