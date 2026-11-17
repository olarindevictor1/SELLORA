import React, { useEffect, useState } from 'react';
import { Copy, Lock, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatLagosDate, formatNgn } from '../../shared/types';

export const AdminCatalogTab: React.FC<{
  initialSubTab?: 'products' | 'inventory' | 'reviews';
  user?: any;
}> = ({
  initialSubTab = 'products',
  user,
}) => {
  const isOwner = user?.role === 'owner';
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
  const [pSkuMode, setPSkuMode] = useState<'auto' | 'manual'>('auto');
  const [pSku, setPSku] = useState('');
  const [pVariantSku, setPVariantSku] = useState('');
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

  // Edit Product Form + Variant Management
  const [editingProd, setEditingProd] = useState<any>(null);
  const [eName, setEName] = useState('');
  const [eSku, setESku] = useState('');
  const [eShort, setEShort] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eCategoryId, setECategoryId] = useState('');
  const [eCollectionId, setECollectionId] = useState('');
  const [ePrice, setEPrice] = useState('');
  const [eSalePrice, setESalePrice] = useState('');
  const [eCostPrice, setECostPrice] = useState('');
  const [eLowThresh, setELowThresh] = useState('5');
  const [eImageUrl, setEImageUrl] = useState('');

  // Add Variant Form inside Edit Product
  const [newVarName, setNewVarName] = useState('');
  const [newVarSkuMode, setNewVarSkuMode] = useState<'auto' | 'manual'>('auto');
  const [newVarSku, setNewVarSku] = useState('');
  const [newVarPrice, setNewVarPrice] = useState('');
  const [newVarStock, setNewVarStock] = useState('0');
  const [variantSkuEdits, setVariantSkuEdits] = useState<Record<string, string>>({});

  // Quick Category
  const [newCatName, setNewCatName] = useState('');

  // Inventory adjustment
  const [adjVariantId, setAdjVariantId] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');

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

  const uploadProductImage = async (file: File, target: 'create' | 'edit' = 'create') => {
    const form = new FormData();
    form.append('file', file);
    const res = await apiFetch<{ url: string }>('/api/admin/media/upload', {
      method: 'POST',
      body: form,
    });
    if (target === 'edit') {
      setEImageUrl(res.url);
    } else {
      setPImageUrl(res.url);
    }
    setMsg('Product image uploaded.');
  };

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ id: string; sku: string; variantSku?: string }>('/api/admin/products', {
        method: 'POST',
        body: JSON.stringify({
          name: pName,
          skuMode: pSkuMode,
          ...(pSkuMode === 'manual' ? { sku: pSku, variantSku: pVariantSku || undefined } : {}),
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
      setPSkuMode('auto');
      setPSku('');
      setPVariantSku('');
      setPShort('');
      setPDesc('');
      setPPrice('');
      setPSalePrice('');
      setPCostPrice('');
      setPImageUrl('');
      setMsg(`Product created with SKU ${res.sku}${res.variantSku ? ` (Variant ${res.variantSku})` : ''}.`);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const openEditProduct = (p: any) => {
    setShowForm(false);
    setEditingProd(p);
    setEName(p.name || '');
    setESku(p.sku || '');
    setEShort(p.short_description || '');
    setEDesc(p.description || '');
    setECategoryId(p.category_id || '');
    setECollectionId(p.collection_id || '');
    setEPrice(p.price_kobo !== null && p.price_kobo !== undefined ? String(p.price_kobo / 100) : '');
    setESalePrice(p.sale_price_kobo !== null && p.sale_price_kobo !== undefined ? String(p.sale_price_kobo / 100) : '');
    setECostPrice(p.cost_price_kobo !== null && p.cost_price_kobo !== undefined ? String(p.cost_price_kobo / 100) : '');
    setELowThresh(String(p.low_stock_threshold ?? 5));
    setEImageUrl((p.media && p.media[0]) || '');
    const vEdits: Record<string, string> = {};
    for (const v of p.variants || []) {
      vEdits[v.id] = v.sku || '';
    }
    setVariantSkuEdits(vEdits);
    setNewVarName('');
    setNewVarSkuMode('auto');
    setNewVarSku('');
    setNewVarPrice(p.price_kobo ? String(p.price_kobo / 100) : '');
    setNewVarStock('0');
  };

  const saveEditProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProd) return;
    setErr(null);
    setMsg(null);
    try {
      const payload: Record<string, unknown> = {
        name: eName,
        shortDescription: eShort,
        description: eDesc,
        categoryId: eCategoryId || null,
        collectionId: eCollectionId || null,
        priceNaira: Number(ePrice),
        salePriceNaira: eSalePrice ? Number(eSalePrice) : null,
        costPriceNaira: eCostPrice ? Number(eCostPrice) : null,
        lowStockThreshold: Number(eLowThresh || 5),
        media: eImageUrl ? [eImageUrl] : editingProd.media || [],
      };
      if (!editingProd.hasOrderedItems && eSku.trim() && eSku.trim().toUpperCase() !== String(editingProd.sku).toUpperCase()) {
        payload.sku = eSku.trim();
      }
      await apiFetch(`/api/admin/products/${editingProd.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setEditingProd(null);
      setMsg('Product updated cleanly.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const addProductVariant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProd || !newVarName.trim()) return;
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ id: string; sku: string }>(
        `/api/admin/products/${editingProd.id}/variants`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: newVarName.trim(),
            skuMode: newVarSkuMode,
            ...(newVarSkuMode === 'manual' ? { sku: newVarSku.trim() } : {}),
            priceNaira: newVarPrice ? Number(newVarPrice) : undefined,
            stockQuantity: Number(newVarStock || 0),
          }),
        }
      );
      setMsg(`Variant added with SKU ${res.sku}.`);
      setNewVarName('');
      setNewVarSku('');
      await load();
      const refreshed = await apiFetch<{ products: any[] }>('/api/admin/products');
      const updated = (refreshed.products || []).find((p) => p.id === editingProd.id);
      if (updated) openEditProduct(updated);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const saveVariantSku = async (variant: any) => {
    const targetSku = (variantSkuEdits[variant.id] || '').trim();
    if (!targetSku) return;
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ sku: string }>(`/api/admin/variants/${variant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ sku: targetSku }),
      });
      setMsg(`Variant SKU updated to ${res.sku}.`);
      await load();
      if (editingProd) {
        const refreshed = await apiFetch<{ products: any[] }>('/api/admin/products');
        const updated = (refreshed.products || []).find((p) => p.id === editingProd.id);
        if (updated) openEditProduct(updated);
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const copySku = async (sku: string) => {
    try {
      await navigator.clipboard.writeText(sku);
      setMsg(`Copied SKU: ${sku}`);
    } catch {
      setMsg(`SKU: ${sku}`);
    }
  };

  const duplicateProduct = async (id: string) => {
    const res = await apiFetch<{ sku?: string }>(`/api/admin/products/${id}/duplicate`, { method: 'POST' });
    setMsg(res?.sku ? `Product duplicated as draft with SKU ${res.sku}.` : 'Product duplicated as draft.');
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
                <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                  <select
                    value={pSkuMode}
                    onChange={(e) => setPSkuMode(e.target.value as 'auto' | 'manual')}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-semibold text-[#172554]"
                    aria-label="SKU Mode"
                  >
                    <option value="auto">Automatic SKU</option>
                    <option value="manual">Manual SKU</option>
                  </select>
                  {pSkuMode === 'auto' ? (
                    <div className="flex-1 rounded-lg border border-slate-200 bg-[#F5F7F4] px-3 py-2 text-slate-500">
                      Unique SLR-... product & variant SKUs generated automatically on save
                    </div>
                  ) : (
                    <>
                      <input
                        type="text"
                        required
                        value={pSku}
                        onChange={(e) => setPSku(e.target.value.toUpperCase())}
                        placeholder="Product SKU * (e.g. SLR-AUDIO-01)"
                        className="flex-1 min-w-[160px] rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular uppercase"
                      />
                      <input
                        type="text"
                        value={pVariantSku}
                        onChange={(e) => setPVariantSku(e.target.value.toUpperCase())}
                        placeholder="Initial Variant SKU (optional)"
                        className="flex-1 min-w-[160px] rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular uppercase"
                      />
                    </>
                  )}
                </div>
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
                  <span>Upload Product Image</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadProductImage(f, 'create');
                    }}
                  />
                </label>
                {pImageUrl && <span className="text-emerald-700 truncate max-w-xs">{pImageUrl}</span>}
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
                      <td className="p-3 font-mono-tabular text-slate-600">
                        <div className="inline-flex items-center gap-1.5">
                          <span>{p.sku}</span>
                          {isOwner && p.sku && (
                            <button
                              type="button"
                              onClick={() => copySku(p.sku)}
                              title={`Copy SKU ${p.sku}`}
                              aria-label={`Copy SKU ${p.sku}`}
                              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-[#172554]"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-slate-600">{p.category_name || '—'}</td>
                      <td className="p-3 text-right tabular-nums font-semibold">
                        {formatNgn(p.sale_price_kobo ?? p.price_kobo)}
                      </td>
                      <td className="p-3 text-right tabular-nums">{totalStock}</td>
                      <td className="p-3 capitalize">{p.status}</td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => openEditProduct(p)}
                            title="Edit Product"
                            className="inline-flex items-center gap-1 text-[#172554] underline"
                          >
                            <Pencil className="w-3 h-3" /> Edit
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

          {editingProd && (
            <form
              onSubmit={saveEditProduct}
              className="rounded-xl bg-white border border-[#172554]/25 p-6 space-y-4 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-[#172554]">Edit Product: {editingProd.name}</h3>
                <span className="text-slate-500">
                  {editingProd.hasOrderedItems
                    ? 'SKU locked because this item appears in existing orders'
                    : 'SKUs must remain unique across all products & variants'}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Product Name *</label>
                  <input
                    type="text"
                    required
                    value={eName}
                    onChange={(e) => setEName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">
                    Product SKU {editingProd.hasOrderedItems ? '(Order-Locked)' : '(Editable)'}
                  </label>
                  {editingProd.hasOrderedItems ? (
                    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-[#F5F7F4] px-3 py-2 font-mono-tabular text-slate-600">
                      <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="flex-1 truncate">{editingProd.sku}</span>
                      {isOwner && editingProd.sku && (
                        <button
                          type="button"
                          onClick={() => copySku(editingProd.sku)}
                          className="text-[#172554] hover:underline font-sans text-[11px] font-semibold"
                        >
                          Copy
                        </button>
                      )}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={eSku}
                      onChange={(e) => setESku(e.target.value.toUpperCase())}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular uppercase"
                    />
                  )}
                </div>
                <div>
                  <label className="block font-semibold mb-1">Category</label>
                  <select
                    value={eCategoryId}
                    onChange={(e) => setECategoryId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="">Select Category</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Collection</label>
                  <select
                    value={eCollectionId}
                    onChange={(e) => setECollectionId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="">Select Collection</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Regular Price (NGN) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={ePrice}
                    onChange={(e) => setEPrice(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Sale Price (NGN)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={eSalePrice}
                    onChange={(e) => setESalePrice(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Cost Price (NGN)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={eCostPrice}
                    onChange={(e) => setECostPrice(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Low-Stock Threshold</label>
                  <input
                    type="number"
                    required
                    value={eLowThresh}
                    onChange={(e) => setELowThresh(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold mb-1">Short Summary</label>
                <input
                  type="text"
                  value={eShort}
                  onChange={(e) => setEShort(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Full Product Description</label>
                <textarea
                  rows={3}
                  value={eDesc}
                  onChange={(e) => setEDesc(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 cursor-pointer hover:bg-slate-50">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Replace Product Image</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadProductImage(f, 'edit');
                    }}
                  />
                </label>
                {eImageUrl && <span className="text-emerald-700 truncate max-w-xs">{eImageUrl}</span>}
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
                >
                  Save Changes
                </button>
                <button
                  type="button"
                  onClick={() => setEditingProd(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-600"
                >
                  Cancel
                </button>
              </div>

              {/* Variants & SKUs Manager */}
              <div className="border-t border-slate-200 pt-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-bold text-[#172554]">
                    Product Variants & SKUs ({(editingProd.variants || []).length})
                  </h4>
                  <span className="text-[11px] text-slate-500">
                    Order-referenced variant SKUs remain immutable to protect order history
                  </span>
                </div>
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {(editingProd.variants || []).map((v: any) => (
                    <div
                      key={v.id}
                      className="p-3 flex flex-wrap items-center justify-between gap-3 bg-[#F5F7F4]/40"
                    >
                      <div>
                        <div className="font-semibold text-[#172554]">{v.name}</div>
                        <div className="text-[11px] text-slate-500 tabular-nums">
                          {formatNgn(v.sale_price_kobo ?? v.price_kobo)} · {v.stock_quantity} in stock
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {v.hasOrderedItems ? (
                          <span className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 font-mono-tabular text-slate-600">
                            <Lock className="w-3 h-3 text-slate-400" /> {v.sku}
                          </span>
                        ) : (
                          <>
                            <input
                              type="text"
                              value={variantSkuEdits[v.id] ?? v.sku}
                              onChange={(e) =>
                                setVariantSkuEdits({
                                  ...variantSkuEdits,
                                  [v.id]: e.target.value.toUpperCase(),
                                })
                              }
                              className="rounded border border-slate-300 bg-white px-2.5 py-1 font-mono-tabular uppercase"
                            />
                            <button
                              type="button"
                              onClick={() => saveVariantSku(v)}
                              className="rounded border border-[#172554] px-2.5 py-1 font-semibold text-[#172554] hover:bg-[#172554] hover:text-[#B7F36B]"
                            >
                              Update SKU
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-6 gap-2 pt-1">
                  <input
                    type="text"
                    value={newVarName}
                    onChange={(e) => setNewVarName(e.target.value)}
                    placeholder="New Variant Name (e.g. Obsidian 64GB)"
                    className="sm:col-span-2 rounded-lg border border-slate-300 px-3 py-1.5"
                  />
                  <select
                    value={newVarSkuMode}
                    onChange={(e) => setNewVarSkuMode(e.target.value as 'auto' | 'manual')}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-semibold"
                  >
                    <option value="auto">Auto SKU</option>
                    <option value="manual">Manual SKU</option>
                  </select>
                  {newVarSkuMode === 'manual' ? (
                    <input
                      type="text"
                      value={newVarSku}
                      onChange={(e) => setNewVarSku(e.target.value.toUpperCase())}
                      placeholder="Variant SKU"
                      className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono-tabular uppercase"
                    />
                  ) : (
                    <input
                      type="number"
                      step="0.01"
                      value={newVarPrice}
                      onChange={(e) => setNewVarPrice(e.target.value)}
                      placeholder="Price NGN"
                      className="rounded-lg border border-slate-300 px-2.5 py-1.5"
                    />
                  )}
                  <input
                    type="number"
                    min={0}
                    value={newVarStock}
                    onChange={(e) => setNewVarStock(e.target.value)}
                    placeholder="Stock"
                    className="rounded-lg border border-slate-300 px-2.5 py-1.5"
                  />
                  <button
                    type="button"
                    onClick={addProductVariant}
                    className="rounded-lg bg-[#172554] px-3 py-1.5 font-bold text-[#B7F36B]"
                  >
                    + Add Variant
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Quick Category Creator */}
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
                <span
                  key={c.id}
                  className="rounded-lg border border-slate-200 bg-[#F5F7F4] px-3 py-1.5 text-xs font-medium text-[#172554]"
                >
                  {c.name}
                </span>
              ))}
            </div>
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
              <label className="block font-semibold mb-1">Product Variant</label>
              <select
                required
                value={adjVariantId}
                onChange={(e) => setAdjVariantId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="">Select product variant</option>
                {inventory.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.product_name} — {i.name} ({i.stock_quantity} on hand)
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
