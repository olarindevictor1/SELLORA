import React, { useEffect, useState } from 'react';
import { Copy, Plus, Trash2, Upload } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatLagosDate, formatNgn } from '../../shared/types';

export const AdminCatalogTab: React.FC<{ initialSubTab?: 'products' | 'inventory' | 'reviews' }> = ({
  initialSubTab = 'products',
}) => {
  const [subTab, setSubTab] = useState<'products' | 'inventory' | 'reviews'>(initialSubTab);
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [collections, setCollections] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [movements, setMovements] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Create Product Form
  const [showForm, setShowForm] = useState(false);
  const [pName, setPName] = useState('');
  const [pSku, setPSku] = useState('');
  const [pShort, setPShort] = useState('');
  const [pDesc, setPDesc] = useState('');
  const [pCategoryId, setPCategoryId] = useState('');
  const [pCollectionId, setPCollectionId] = useState('');
  const [pPrice, setPPrice] = useState('');
  const [pSalePrice, setPSalePrice] = useState('');
  const [pCostPrice, setPCostPrice] = useState('');
  const [pStock, setPStock] = useState('10');
  const [pLowThresh, setPLowThresh] = useState('5');
  const [pImageUrl, setPImageUrl] = useState('');

  // Quick Category
  const [newCatName, setNewCatName] = useState('');

  // Inventory adjustment
  const [adjVariantId, setAdjVariantId] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');

  // Inline Product SEO Editor
  const [editingSeoProd, setEditingSeoProd] = useState<any>(null);
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDesc, setSeoDesc] = useState('');
  const [seoCanonical, setSeoCanonical] = useState('');
  const [seoImage, setSeoImage] = useState('');
  const [imageAlt, setImageAlt] = useState('');

  // Inline Category SEO Editor
  const [editingSeoCat, setEditingSeoCat] = useState<any>(null);
  const [catSeoTitle, setCatSeoTitle] = useState('');
  const [catSeoDesc, setCatSeoDesc] = useState('');

  const load = async () => {
    try {
      const [prodRes, catRes, colRes, invRes, revRes] = await Promise.all([
        apiFetch<{ products: any[] }>('/api/admin/products'),
        apiFetch<{ categories: any[] }>('/api/admin/categories'),
        apiFetch<{ collections: any[] }>('/api/admin/collections'),
        apiFetch<{ items: any[]; movements: any[] }>('/api/admin/inventory'),
        apiFetch<{ reviews: any[] }>('/api/admin/reviews'),
      ]);
      setProducts(prodRes.products || []);
      setCategories(catRes.categories || []);
      setCollections(colRes.collections || []);
      setInventory(invRes.items || []);
      setMovements(invRes.movements || []);
      setReviews(revRes.reviews || []);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const uploadProductImage = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await apiFetch<{ url: string }>('/api/admin/media/upload', {
      method: 'POST',
      body: form,
    });
    setPImageUrl(res.url);
    setMsg('Product image uploaded.');
  };

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await apiFetch('/api/admin/products', {
        method: 'POST',
        body: JSON.stringify({
          name: pName,
          sku: pSku,
          shortDescription: pShort,
          description: pDesc,
          categoryId: pCategoryId || null,
          collectionId: pCollectionId || null,
          priceNaira: Number(pPrice),
          salePriceNaira: pSalePrice ? Number(pSalePrice) : null,
          costPriceNaira: pCostPrice ? Number(pCostPrice) : null,
          stockQuantity: Number(pStock || 0),
          lowStockThreshold: Number(pLowThresh || 5),
          media: pImageUrl ? [pImageUrl] : [],
          status: 'active',
          isFeatured: true,
        }),
      });
      setShowForm(false);
      setPName('');
      setPSku('');
      setPShort('');
      setPDesc('');
      setPPrice('');
      setPSalePrice('');
      setPCostPrice('');
      setPImageUrl('');
      setMsg('Product created in database.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const duplicateProduct = async (id: string) => {
    await apiFetch(`/api/admin/products/${id}/duplicate`, { method: 'POST' });
    setMsg('Product duplicated as draft.');
    await load();
  };

  const toggleProductStatus = async (p: any) => {
    const next = p.status === 'active' ? 'archived' : 'active';
    await apiFetch(`/api/admin/products/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    });
    await load();
  };

  const deleteProduct = async (id: string) => {
    await apiFetch(`/api/admin/products/${id}`, { method: 'DELETE' });
    await load();
  };

  const addCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    await apiFetch('/api/admin/categories', {
      method: 'POST',
      body: JSON.stringify({ name: newCatName }),
    });
    setNewCatName('');
    await load();
  };

  const openProductSeo = (p: any) => {
    setEditingSeoProd(p);
    setSeoTitle(p.seo_title || '');
    setSeoDesc(p.seo_description || '');
    setSeoCanonical(p.seo_canonical_url || '');
    setSeoImage(p.seo_image_url || '');
    setImageAlt(p.image_alt || '');
  };

  const saveProductSeo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSeoProd) return;
    setErr(null);
    try {
      await apiFetch(`/api/admin/products/${editingSeoProd.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          seoTitle,
          seoDescription: seoDesc,
          seoCanonicalUrl: seoCanonical,
          seoImageUrl: seoImage,
          imageAlt,
        }),
      });
      setEditingSeoProd(null);
      setMsg('Product SEO metadata saved.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const openCategorySeo = (c: any) => {
    setEditingSeoCat(c);
    setCatSeoTitle(c.seo_title || '');
    setCatSeoDesc(c.seo_description || '');
  };

  const saveCategorySeo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSeoCat) return;
    setErr(null);
    try {
      await apiFetch(`/api/admin/categories/${editingSeoCat.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          seoTitle: catSeoTitle,
          seoDescription: catSeoDesc,
        }),
      });
      setEditingSeoCat(null);
      setMsg('Category SEO metadata saved.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const adjustInventory = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await apiFetch('/api/admin/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({
          variantId: adjVariantId,
          changeAmount: Number(adjAmount),
          reason: adjReason,
        }),
      });
      setAdjAmount('');
      setAdjReason('');
      setMsg('Stock level updated and logged in inventory movements.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const moderateReview = async (id: string, status: 'approved' | 'rejected') => {
    await apiFetch(`/api/admin/reviews/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-xl">
          {[
            { id: 'products', label: 'Products & Categories' },
            { id: 'inventory', label: 'Inventory & Stock Ledger' },
            { id: 'reviews', label: 'Review Moderation' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as any)}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold ${
                subTab === t.id ? 'bg-[#172554] text-[#B7F36B]' : 'text-slate-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {subTab === 'products' && (
          <button
            type="button"
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
          >
            <Plus className="w-3.5 h-3.5" /> New Product
          </button>
        )}
      </div>

      {msg && (
        <div className="rounded-lg bg-[#B7F36B]/30 border border-[#172554]/20 px-4 py-2.5 text-xs font-semibold text-[#172554]">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded-lg bg-[#F47B68]/15 border border-[#F47B68]/40 px-4 py-2.5 text-xs font-semibold text-[#9A2E1E]">
          {err}
        </div>
      )}

      {subTab === 'products' && (
        <div className="space-y-6">
          {showForm && (
            <form
              onSubmit={createProduct}
              className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs"
            >
              <h3 className="text-sm font-bold text-[#172554]">Create Store Product</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  required
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                  placeholder="Product Name *"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="text"
                  required
                  value={pSku}
                  onChange={(e) => setPSku(e.target.value)}
                  placeholder="SKU (e.g. SLR-NEW-005) *"
                  className="rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                />
                <select
                  value={pCategoryId}
                  onChange={(e) => setPCategoryId(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="">Select Category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={pCollectionId}
                  onChange={(e) => setPCollectionId(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="">Select Collection</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={pPrice}
                  onChange={(e) => setPPrice(e.target.value)}
                  placeholder="Regular Price (NGN) *"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="number"
                  step="0.01"
                  value={pSalePrice}
                  onChange={(e) => setPSalePrice(e.target.value)}
                  placeholder="Sale Price (NGN, optional)"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="number"
                  step="0.01"
                  value={pCostPrice}
                  onChange={(e) => setPCostPrice(e.target.value)}
                  placeholder="Cost Price (NGN, for profit)"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="number"
                  required
                  value={pStock}
                  onChange={(e) => setPStock(e.target.value)}
                  placeholder="Initial Stock *"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="number"
                  required
                  value={pLowThresh}
                  onChange={(e) => setPLowThresh(e.target.value)}
                  placeholder="Low-Stock Threshold"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <input
                type="text"
                value={pShort}
                onChange={(e) => setPShort(e.target.value)}
                placeholder="Short summary"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <textarea
                rows={3}
                value={pDesc}
                onChange={(e) => setPDesc(e.target.value)}
                placeholder="Full product description"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 cursor-pointer hover:bg-slate-50">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload Image to Storage</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadProductImage(f);
                    }}
                  />
                </label>
                {pImageUrl && <span className="text-emerald-700 font-mono-tabular">{pImageUrl}</span>}
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
                >
                  Save Product
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-600"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Products Table */}
          <div className="rounded-xl bg-white border border-slate-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#F5F7F4] text-left text-slate-500 border-b border-slate-200">
                  <th className="p-3">Product</th>
                  <th className="p-3">SKU</th>
                  <th className="p-3">Category</th>
                  <th className="p-3 text-right">Price</th>
                  <th className="p-3 text-right">Stock</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {products.map((p) => {
                  const totalStock = (p.variants || []).reduce(
                    (acc: number, v: any) => acc + Number(v.stock_quantity || 0),
                    0
                  );
                  return (
                    <tr key={p.id}>
                      <td className="p-3 font-semibold text-[#172554]">{p.name}</td>
                      <td className="p-3 font-mono-tabular text-slate-500">{p.sku}</td>
                      <td className="p-3 text-slate-600">{p.category_name || '—'}</td>
                      <td className="p-3 text-right tabular-nums font-semibold">
                        {formatNgn(p.sale_price_kobo ?? p.price_kobo)}
                      </td>
                      <td className="p-3 text-right tabular-nums">{totalStock}</td>
                      <td className="p-3 capitalize">{p.status}</td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openProductSeo(p)}
                            className="text-[#172554] underline"
                          >
                            Edit SEO
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleProductStatus(p)}
                            className="text-[#172554] underline"
                          >
                            {p.status === 'active' ? 'Archive' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            onClick={() => duplicateProduct(p.id)}
                            title="Duplicate"
                            className="text-slate-500 hover:text-[#172554]"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteProduct(p.id)}
                            title="Delete"
                            className="text-slate-400 hover:text-[#F47B68]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {editingSeoProd && (
            <form
              onSubmit={saveProductSeo}
              className="rounded-xl bg-white border border-[#172554]/25 p-5 space-y-3 text-xs"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-[#172554]">
                  Product SEO & Image Alt: {editingSeoProd.name}
                </h3>
                <span className="font-mono-tabular text-slate-400">
                  /product/{editingSeoProd.slug}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">SEO Title (30–60 chars)</label>
                  <input
                    type="text"
                    value={seoTitle}
                    onChange={(e) => setSeoTitle(e.target.value)}
                    placeholder={`${editingSeoProd.name} — SELLORA`}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Image Alt Text</label>
                  <input
                    type="text"
                    value={imageAlt}
                    onChange={(e) => setImageAlt(e.target.value)}
                    placeholder={`Descriptive alt text for ${editingSeoProd.name}`}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Canonical URL Override (optional)</label>
                  <input
                    type="text"
                    value={seoCanonical}
                    onChange={(e) => setSeoCanonical(e.target.value)}
                    placeholder={`/product/${editingSeoProd.slug}`}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Social Share / OG Image URL</label>
                  <input
                    type="text"
                    value={seoImage}
                    onChange={(e) => setSeoImage(e.target.value)}
                    placeholder="https://... or /api/media/products/..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-semibold mb-1">SEO Meta Description (120–160 chars)</label>
                  <textarea
                    rows={2}
                    value={seoDesc}
                    onChange={(e) => setSeoDesc(e.target.value)}
                    placeholder="Concise search snippet summarizing product benefits and NGN value..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
                >
                  Save Product SEO
                </button>
                <button
                  type="button"
                  onClick={() => setEditingSeoProd(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-600"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Quick Category Creator & Category SEO */}
          <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-3 text-xs">
            <form onSubmit={addCategory} className="flex flex-wrap items-center gap-3">
              <span className="font-bold text-[#172554]">Categories ({categories.length}):</span>
              <input
                type="text"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="New category name"
                className="rounded-lg border border-slate-300 px-3 py-1.5"
              />
              <button
                type="submit"
                className="rounded-lg bg-[#172554] px-3 py-1.5 font-semibold text-[#B7F36B]"
              >
                Add Category
              </button>
            </form>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openCategorySeo(c)}
                  className="rounded-lg border border-slate-200 bg-[#F5F7F4] px-3 py-1.5 text-xs font-medium text-[#172554] hover:border-[#172554]"
                >
                  {c.name} · Edit SEO
                </button>
              ))}
            </div>
            {editingSeoCat && (
              <form
                onSubmit={saveCategorySeo}
                className="pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-3"
              >
                <input
                  type="text"
                  value={catSeoTitle}
                  onChange={(e) => setCatSeoTitle(e.target.value)}
                  placeholder={`${editingSeoCat.name} — SELLORA`}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="text"
                  value={catSeoDesc}
                  onChange={(e) => setCatSeoDesc(e.target.value)}
                  placeholder="Category search description..."
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <div className="sm:col-span-2 flex gap-2">
                  <button
                    type="submit"
                    className="rounded-lg bg-[#172554] px-3.5 py-1.5 font-bold text-[#B7F36B]"
                  >
                    Save Category SEO
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingSeoCat(null)}
                    className="rounded-lg border border-slate-300 px-3.5 py-1.5 font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {subTab === 'inventory' && (
        <div className="space-y-6">
          <form
            onSubmit={adjustInventory}
            className="rounded-xl bg-white border border-slate-200 p-5 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs items-end"
          >
            <div>
              <label className="block font-semibold mb-1">Variant / SKU</label>
              <select
                required
                value={adjVariantId}
                onChange={(e) => setAdjVariantId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="">Select SKU</option>
                {inventory.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.sku} — {i.product_name} ({i.stock_quantity} on hand)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-semibold mb-1">Adjustment (+/-)</label>
              <input
                type="number"
                required
                value={adjAmount}
                onChange={(e) => setAdjAmount(e.target.value)}
                placeholder="e.g. +10 or -2"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold mb-1">Reason</label>
              <input
                type="text"
                required
                value={adjReason}
                onChange={(e) => setAdjReason(e.target.value)}
                placeholder="Restock / Damage / Count"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <button
              type="submit"
              className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
            >
              Apply Adjustment
            </button>
          </form>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
              <h3 className="text-sm font-bold text-[#172554]">Current Stock Levels</h3>
              <div className="divide-y divide-slate-100 text-xs">
                {inventory.map((i) => {
                  const isOut = i.stock_quantity === 0;
                  const isLow = i.stock_quantity > 0 && i.stock_quantity <= i.low_stock_threshold;
                  return (
                    <div key={i.id} className="py-2.5 flex justify-between items-center gap-3">
                      <div>
                        <div className="font-semibold text-[#1E293B]">
                          {i.product_name} · {i.name}
                        </div>
                        <div className="font-mono-tabular text-slate-400">{i.sku}</div>
                      </div>
                      <div className="text-right">
                        <span
                          className={`font-bold tabular-nums ${
                            isOut
                              ? 'text-[#9A2E1E]'
                              : isLow
                                ? 'text-amber-700'
                                : 'text-[#172554]'
                          }`}
                        >
                          {i.stock_quantity} units
                        </span>
                        {isOut && <div className="text-[10px] text-[#9A2E1E]">Out of Stock</div>}
                        {isLow && <div className="text-[10px] text-amber-700">Low Stock</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
              <h3 className="text-sm font-bold text-[#172554]">Stock Movement Ledger</h3>
              <div className="divide-y divide-slate-100 text-xs max-h-96 overflow-y-auto">
                {movements.length === 0 ? (
                  <p className="text-slate-500">No inventory movements recorded yet.</p>
                ) : (
                  movements.map((m) => (
                    <div key={m.id} className="py-2 flex justify-between gap-3">
                      <div>
                        <div className="font-semibold">
                          {m.product_name} ({m.sku})
                        </div>
                        <div className="text-slate-500">{m.reason}</div>
                      </div>
                      <div className="text-right tabular-nums">
                        <div className="font-bold text-[#172554]">
                          {m.change_amount > 0 ? `+${m.change_amount}` : m.change_amount} ({m.previous_qty} → {m.new_qty})
                        </div>
                        <div className="text-[10px] text-slate-400">{formatLagosDate(m.created_at)}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {subTab === 'reviews' && (
        <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-4">
          <h3 className="text-sm font-bold text-[#172554]">Customer Reviews Moderation</h3>
          {reviews.length === 0 ? (
            <p className="text-xs text-slate-500">No customer reviews submitted yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 text-xs">
              {reviews.map((r) => (
                <div key={r.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-[#172554]">
                      {r.product_name} · {r.rating}/5 by {r.customer_name} ({r.status})
                    </div>
                    <p className="text-slate-600 mt-0.5">{r.body}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => moderateReview(r.id, 'approved')}
                      className="rounded-lg bg-[#172554] px-3 py-1 font-semibold text-[#B7F36B]"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => moderateReview(r.id, 'rejected')}
                      className="rounded-lg border border-slate-300 px-3 py-1 font-semibold text-slate-600"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
