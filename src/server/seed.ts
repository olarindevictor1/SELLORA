import type { SelloraDb } from './db';

export async function seedInitialStoreData(db: SelloraDb): Promise<void> {
  const now = new Date().toISOString();

  const existingTheme = await db.get<{ key: string }>(
    `SELECT key FROM store_settings WHERE key = 'theme'`
  );
  if (!existingTheme) {
    await db.run(
      `INSERT INTO store_settings (key, value_json, updated_at) VALUES ('theme', ?, ?)`,
      [
        JSON.stringify({
          storeName: 'SELLORA',
          tagline: 'Commerce without limits.',
          storeDescription:
            'Single-store Nigerian ecommerce platform operating in NGN with verified fulfilment and real-time tracking.',
          logoUrl: '/icon.svg',
          faviconUrl: '/icon.svg',
          primaryColor: '#172554',
          accentColor: '#B7F36B',
          storeStatus: 'active',
          currency: 'NGN',
          timezone: 'Africa/Lagos',
          announcementEnabled: true,
          announcementText: 'Nationwide delivery across configured Nigerian states — Track every order in real time.',
          heroHeadline: 'Curated essentials built for modern Nigerian commerce.',
          heroSubtitle:
            'Precision audio, structured leather goods, and workspace hardware backed by transparent NGN pricing and verified delivery tracking.',
          heroImage: '/src/assets/images/hero_sellora_editorial_1794648058731.jpg',
          maintenanceMode: false,
          draftMode: false,
          aboutContent:
            'SELLORA is a single-store Nigerian retail platform committed to transparent NGN pricing, genuine inventory accountability, and reliable nationwide fulfilment.',
          contactEmail: '',
          contactPhone: '',
          contactAddress: 'Lagos, Nigeria',
          faq: [
            {
              q: 'How do manual bank transfers work?',
              a: 'After placing your order, transfer the exact NGN total to the store bank account shown at checkout and upload your payment receipt. Our team verifies transfers before dispatch.',
            },
            {
              q: 'How can I track my order?',
              a: 'Use the Track Order page with your Order Number and the email or phone number used at checkout, or view live progress directly inside your SELLORA account.',
            },
          ],
          policies: {
            shipping:
              'Delivery fees and estimated timelines depend on your Nigerian State and LGA configured in our Delivery Zones. Orders are dispatched once payment is verified.',
            returns:
              'Eligible items in unused condition with original packaging may be reviewed for return within 7 days of delivery.',
            privacy:
              'Customer addresses, contact details, and payment evidence are stored securely and restricted strictly to order fulfilment and support.',
            terms:
              'Orders placed on SELLORA are priced in Nigerian Naira (NGN). Manual bank transfers require verification before dispatch.',
          },
        }),
        now,
      ]
    );
  }

  const existingSeo = await db.get<{ key: string }>(
    `SELECT key FROM store_settings WHERE key = 'seo'`
  );
  if (!existingSeo) {
    await db.run(
      `INSERT INTO store_settings (key, value_json, updated_at) VALUES ('seo', ?, ?)`,
      [
        JSON.stringify({
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
        }),
        now,
      ]
    );
  }

  const existingBank = await db.get<{ key: string }>(
    `SELECT key FROM store_settings WHERE key = 'bank_transfer'`
  );
  if (!existingBank) {
    await db.run(
      `INSERT INTO store_settings (key, value_json, updated_at) VALUES ('bank_transfer', ?, ?)`,
      [
        JSON.stringify({
          configured: false,
          bankName: '',
          accountName: '',
          accountNumber: '',
          paymentInstructions:
            'Transfer the exact order total and upload your transaction receipt on the order confirmation or Track Order page.',
          referenceInstructions: 'Include your SELLORA Order Number in the transfer narration.',
        }),
        now,
      ]
    );
  }

  const existingEmail = await db.get<{ key: string }>(
    `SELECT key FROM store_settings WHERE key = 'email'`
  );
  if (!existingEmail) {
    await db.run(
      `INSERT INTO store_settings (key, value_json, updated_at) VALUES ('email', ?, ?)`,
      [
        JSON.stringify({
          adminNotificationEmail: '',
          fromEmail: '',
          fromName: 'SELLORA',
          testEmailRecipient: '',
        }),
        now,
      ]
    );
  }

  const initialized = await db.get<{ key: string }>(
    `SELECT key FROM store_settings WHERE key = 'catalog_seeded'`
  );
  if (initialized) return;

  const productCount = await db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM products`);
  if ((productCount?.cnt ?? 0) === 0) {
    // Seed editable starter studio catalog with 0 fake reviews & 0 fake orders
    await db.run(
      `INSERT INTO categories (id, name, slug, description, sort_order, is_active, created_at) VALUES
       ('cat_audio', 'Audio & Tech', 'audio-tech', 'Wireless studio acoustics and precision electronics', 1, 1, ?),
       ('cat_carry', 'Leather & Carry', 'leather-carry', 'Structured everyday totes and travel goods', 2, 1, ?),
       ('cat_time', 'Timepieces', 'timepieces', 'Minimalist brushed titanium chronographs', 3, 1, ?),
       ('cat_desk', 'Workspace', 'workspace', 'Tactile mechanical keyboards and desk essentials', 4, 1, ?)`,
      [now, now, now, now]
    );

    await db.run(
      `INSERT INTO collections (id, name, slug, description, is_featured, is_active, created_at) VALUES
       ('col_signature', 'Signature Studio', 'signature-studio', 'Core flagship hardware and leather goods', 1, 1, ?),
       ('col_new', 'New Arrivals', 'new-arrivals', 'Latest additions to the SELLORA store', 1, 1, ?)`,
      [now, now]
    );

    const starterProducts = [
      {
        id: 'prod_studio_headphones',
        name: 'Sora Studio Wireless Headphones',
        slug: 'sora-studio-wireless-headphones',
        sku: 'SLR-AUD-001',
        categoryId: 'cat_audio',
        collectionId: 'col_signature',
        shortDescription: 'Active noise-cancelling over-ear headphones in anodized aluminum and midnight navy leather.',
        description:
          'Engineered with 40mm custom neodymium drivers, brushed aluminum yokes, and memory-foam ear cushions wrapped in soft midnight-navy protein leather. Up to 38 hours of continuous wireless playback via Bluetooth 5.3 and USB-C lossless audio.',
        specs: [
          { label: 'Drivers', value: '40mm Dynamic Neodymium' },
          { label: 'Battery Life', value: 'Up to 38 Hours (ANC On)' },
          { label: 'Connectivity', value: 'Bluetooth 5.3 · USB-C Audio' },
          { label: 'Weight', value: '275g' },
        ],
        priceKobo: 18500000, // ₦185,000
        salePriceKobo: null,
        costPriceKobo: 12200000,
        image: '/src/assets/images/product_audio_headphones_1794648058070.jpg',
        variants: [
          { id: 'var_hp_navy', name: 'Midnight Navy / Brushed Silver', sku: 'SLR-AUD-001-NVY', stock: 14, priceKobo: 18500000 },
          { id: 'var_hp_slate', name: 'Graphite Slate / Matte Silver', sku: 'SLR-AUD-001-SLT', stock: 8, priceKobo: 18500000 },
        ],
      },
      {
        id: 'prod_architect_tote',
        name: 'Aba Structured Pebble Leather Tote',
        slug: 'aba-structured-pebble-leather-tote',
        sku: 'SLR-LTH-002',
        categoryId: 'cat_carry',
        collectionId: 'col_signature',
        shortDescription: 'Full-grain structured pebble leather tote with padded 16-inch laptop sleeve.',
        description:
          'Crafted from supple midnight-navy pebble-grain leather with contrast saddle stitching and solid brushed brass hardware. Designed to stand upright on its own while accommodating a 16-inch laptop, documents, and daily essentials.',
        specs: [
          { label: 'Material', value: 'Full-grain pebble cowhide leather' },
          { label: 'Laptop Fit', value: 'Up to 16 inches (padded divider)' },
          { label: 'Dimensions', value: '39cm × 30cm × 14cm' },
          { label: 'Hardware', value: 'Brushed brass rivets & D-rings' },
        ],
        priceKobo: 14200000, // ₦142,000
        salePriceKobo: 12900000, // ₦129,000
        costPriceKobo: 8800000,
        image: '/src/assets/images/product_leather_tote_1794648059079.jpg',
        variants: [
          { id: 'var_tote_navy', name: 'Deep Navy / Brass', sku: 'SLR-LTH-002-NVY', stock: 10, priceKobo: 14200000, salePriceKobo: 12900000 },
        ],
      },
      {
        id: 'prod_titanium_chrono',
        name: 'Meridian Grade-5 Titanium Chronograph',
        slug: 'meridian-titanium-chronograph',
        sku: 'SLR-TMP-003',
        categoryId: 'cat_time',
        collectionId: 'col_new',
        shortDescription: '40mm brushed titanium chronograph with sapphire crystal and textured FKM strap.',
        description:
          'Machined from lightweight Grade-5 titanium with a matte charcoal sunburst dial, recessed chronograph sub-dials, anti-reflective sapphire crystal, and 100m water resistance.',
        specs: [
          { label: 'Case', value: '40mm Grade-5 Brushed Titanium' },
          { label: 'Crystal', value: 'Domed Sapphire with AR Coating' },
          { label: 'Water Resistance', value: '10 ATM / 100 Meters' },
          { label: 'Strap', value: '20mm Quick-Release Textured FKM' },
        ],
        priceKobo: 24500000, // ₦245,000
        salePriceKobo: null,
        costPriceKobo: 16500000,
        image: '/src/assets/images/product_smart_watch_1794648059648.jpg',
        variants: [
          { id: 'var_watch_slate', name: 'Titanium / Slate Strap', sku: 'SLR-TMP-003-SLT', stock: 6, priceKobo: 24500000 },
        ],
      },
      {
        id: 'prod_anodized_keyboard',
        name: 'Kano TKL Anodized Mechanical Keyboard',
        slug: 'kano-tkl-mechanical-keyboard',
        sku: 'SLR-WRK-004',
        categoryId: 'cat_desk',
        collectionId: 'col_new',
        shortDescription: 'CNC aluminum tenkeyless wireless mechanical keyboard with hot-swappable tactile switches.',
        description:
          'Built on a solid bead-blasted aluminum chassis with gasket-mounted acoustic dampening, PBT double-shot keycaps, tri-mode connectivity (USB-C, 2.4GHz, Bluetooth), and programmable QMK/VIA firmware.',
        specs: [
          { label: 'Chassis', value: 'CNC 6063 Anodized Aluminum' },
          { label: 'Layout', value: '80% Tenkeyless (87 Keys)' },
          { label: 'Connectivity', value: 'USB-C · 2.4GHz · Bluetooth 5.1' },
          { label: 'Keycaps', value: 'Double-shot Matte PBT' },
        ],
        priceKobo: 11800000, // ₦118,000
        salePriceKobo: null,
        costPriceKobo: 7600000,
        image: '/src/assets/images/product_ceramic_desk_1794648060587.jpg',
        variants: [
          { id: 'var_kb_tactile', name: 'Slate Gray / Tactile Switches', sku: 'SLR-WRK-004-TAC', stock: 12, priceKobo: 11800000 },
          { id: 'var_kb_linear', name: 'Slate Gray / Linear Switches', sku: 'SLR-WRK-004-LIN', stock: 9, priceKobo: 11800000 },
        ],
      },
    ];

    for (const p of starterProducts) {
      await db.run(
        `INSERT INTO products (
          id, name, slug, sku, brand, short_description, description, specifications_json,
          category_id, collection_id, price_kobo, sale_price_kobo, cost_price_kobo,
          track_inventory, low_stock_threshold, status, is_featured, media_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'SELLORA', ?, ?, ?, ?, ?, ?, ?, ?, 1, 5, 'active', 1, ?, ?, ?)`,
        [
          p.id,
          p.name,
          p.slug,
          p.sku,
          p.shortDescription,
          p.description,
          JSON.stringify(p.specs),
          p.categoryId,
          p.collectionId,
          p.priceKobo,
          p.salePriceKobo,
          p.costPriceKobo,
          JSON.stringify([p.image]),
          now,
          now,
        ]
      );

      for (const v of p.variants) {
        await db.run(
          `INSERT INTO product_variants (
            id, product_id, name, sku, attributes_json, price_kobo, sale_price_kobo, cost_price_kobo,
            stock_quantity, reserved_quantity, is_active, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
          [
            v.id,
            p.id,
            v.name,
            v.sku,
            JSON.stringify({ Edition: v.name }),
            v.priceKobo,
            'salePriceKobo' in v ? (v.salePriceKobo ?? null) : null,
            p.costPriceKobo,
            v.stock,
            now,
          ]
        );
      }
    }
  }

  await db.run(
    `INSERT OR IGNORE INTO store_settings (key, value_json, updated_at) VALUES ('catalog_seeded', '{"seeded":true}', ?)`,
    [now]
  );
}
