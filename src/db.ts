import { MongoClient, Db } from "mongodb";
import { decryptCodeOrPlain, encryptCode } from "./utils/codeCrypto.js";

let client: MongoClient;
let db: Db;
let walletsDb: Db;
let catalogsDb: Db;

const merchantBioTemplates = [
  "{{storeName}} is your trusted merchant store for instant digital delivery and dependable support.",
  "Welcome to {{storeName}}, a verified merchant store focused on speed, reliability, and secure transactions.",
  "{{storeName}} provides quality digital products with fast fulfillment and merchant-grade service.",
  "At {{storeName}}, we combine competitive prices with smooth delivery and consistent customer support.",
  "{{storeName}} is built for buyers who want reliable digital products from a dedicated merchant store.",
];

const generateMerchantStoreBio = (storeName: string): string => {
  const normalizedStoreName = storeName.trim() || "This store";
  const template = merchantBioTemplates[Math.floor(Math.random() * merchantBioTemplates.length)]
    || "{{storeName}} is a verified merchant store on Gameket.";

  return template.replace(/\{\{storeName\}\}/g, normalizedStoreName);
};

export async function connectDB(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not defined in .env");
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db("Main");
  walletsDb = client.db("Wallets");
  catalogsDb = client.db("Catalogs");

  await db.collection("AuditLogs").createIndex({ createdAt: -1 });
  await db.collection("AuditLogs").createIndex({ eventName: 1, createdAt: -1 });
  await db.collection("AuditLogs").createIndex({ actorId: 1, createdAt: -1 });
  await db.collection("AuditLogs").createIndex({ targetId: 1, createdAt: -1 });
  const storesCollection = catalogsDb.collection("Stores");
  const expectedMerchantApiKeyFilter = { merchantApiKey: { $type: "string" } };
  const storeIndexes = await storesCollection.indexes();
  const merchantApiKeyIndex = storeIndexes.find((index) => index.key?.merchantApiKey === 1);

  const hasExpectedMerchantApiKeyIndex = Boolean(
    merchantApiKeyIndex
      && merchantApiKeyIndex.unique === true
      && JSON.stringify(merchantApiKeyIndex.partialFilterExpression ?? null) === JSON.stringify(expectedMerchantApiKeyFilter)
  );

  if (
    merchantApiKeyIndex
    && typeof merchantApiKeyIndex.name === "string"
    && !hasExpectedMerchantApiKeyIndex
  ) {
    await storesCollection.dropIndex(merchantApiKeyIndex.name);
  }

  if (!hasExpectedMerchantApiKeyIndex) {
    await storesCollection.createIndex(
      { merchantApiKey: 1 },
      { unique: true, partialFilterExpression: expectedMerchantApiKeyFilter }
    );
  }

  await catalogsDb.collection("MerchantRequestNonces").createIndex(
    { storeId: 1, nonce: 1 },
    { unique: true, name: "merchant_nonce_unique_idx" }
  );
  await catalogsDb.collection("MerchantRequestNonces").createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "merchant_nonce_ttl_idx" }
  );

  await catalogsDb.collection("MerchantIdempotencyKeys").createIndex(
    { storeId: 1, operation: 1, idempotencyKey: 1 },
    { unique: true, name: "merchant_idempotency_unique_idx" }
  );
  await catalogsDb.collection("MerchantIdempotencyKeys").createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "merchant_idempotency_ttl_idx" }
  );

  console.log("✅ Connected to MongoDB");

  // Backfill createdAt for existing stores that don't have it
  await catalogsDb.collection("Stores").updateMany(
    { createdAt: { $exists: false } },
    { $set: { createdAt: new Date().toISOString() } }
  );

  // Backfill authProvider for existing accounts that don't have it
  await db.collection("accounts").updateMany(
    { authProvider: { $exists: false } },
    { $set: { authProvider: "email" } }
  );

  // Backfill delivery option for existing users
  await db.collection("users").updateMany(
    { deliveryOption: { $exists: false } },
    { $set: { deliveryOption: "email" } }
  );

  // Backfill type for existing products that don't have it
  await catalogsDb.collection("Products").updateMany(
    { type: { $exists: false } },
    { $set: { type: "Auto" } }
  );

  // Backfill API metadata for existing products
  await catalogsDb.collection("Products").updateMany(
    {
      $or: [
        { isAPI: { $exists: false } },
        { isAPI: null },
        { isAPI: { $type: "string" } },
        { isAPI: { $type: "int" } },
        { isAPI: { $type: "long" } },
        { isAPI: { $type: "double" } },
        { isAPI: { $type: "decimal" } },
      ],
    },
    { $set: { isAPI: false } }
  );

  await catalogsDb.collection("Products").updateMany(
    { apiCallbackUrl: { $exists: false } },
    { $set: { apiCallbackUrl: null } }
  );

  // Backfill isApproved: convert string values back to boolean
  await catalogsDb.collection("Stores").updateMany(
    { isApproved: "approved" },
    { $set: { isApproved: true, approveStatus: "success" } }
  );
  await catalogsDb.collection("Stores").updateMany(
    { isApproved: "pending" },
    { $set: { isApproved: false, approveStatus: "pending" } }
  );
  await catalogsDb.collection("Stores").updateMany(
    { isApproved: "rejected" },
    { $set: { isApproved: false, approveStatus: "failed" } }
  );
  await catalogsDb.collection("Stores").updateMany(
    { isApproved: "false" },
    { $set: { isApproved: false, approveStatus: null } }
  );
  await catalogsDb.collection("Stores").updateMany(
    { isApproved: { $exists: false } },
    { $set: { isApproved: false, approveStatus: null } }
  );

  // Backfill approveStatus for stores that don't have it
  await catalogsDb.collection("Stores").updateMany(
    { approveStatus: { $exists: false } },
    { $set: { approveStatus: null } }
  );

  // Backfill isActive: set true for all existing stores
  await catalogsDb.collection("Stores").updateMany(
    { isActive: false },
    { $set: { isActive: true } }
  );

  // Backfill requestCount for existing stores
  await catalogsDb.collection("Stores").updateMany(
    { requestCount: { $exists: false } },
    { $set: { requestCount: 0 } }
  );

  // Backfill merchant bio for existing merchant stores where bio is missing
  const merchantsWithoutBioCursor = catalogsDb
    .collection("Stores")
    .find({
      type: "merchant",
      $or: [
        { bio: { $exists: false } },
        { bio: null },
        { bio: "" },
      ],
    })
    .project({ _id: 1, storeName: 1 });

  const merchantBioBulkOps: any[] = [];
  let merchantBioBackfilledCount = 0;

  for await (const store of merchantsWithoutBioCursor) {
    merchantBioBulkOps.push({
      updateOne: {
        filter: { _id: store._id as any },
        update: {
          $set: {
            bio: generateMerchantStoreBio(String(store.storeName || "This store")),
          },
        },
      },
    });

    merchantBioBackfilledCount += 1;

    if (merchantBioBulkOps.length >= 500) {
      await catalogsDb.collection("Stores").bulkWrite(merchantBioBulkOps, { ordered: false });
      merchantBioBulkOps.length = 0;
    }
  }

  if (merchantBioBulkOps.length > 0) {
    await catalogsDb.collection("Stores").bulkWrite(merchantBioBulkOps, { ordered: false });
  }

  if (merchantBioBackfilledCount > 0) {
    console.log(`✅ Backfilled merchant bio for ${merchantBioBackfilledCount} store(s)`);
  }

  // Backfill: Manual orders that are still stuck in "pending" from older fulfilment behavior
  // Current manual lifecycle is billed -> completed (or cancelled/refunded), so pending is stale.
  const stalePendingManualOrders = await walletsDb
    .collection("Orders")
    .find({ type: "Manual", status: "pending" })
    .project({ orderId: 1, buyerId: 1, sellerId: 1 })
    .toArray();

  if (stalePendingManualOrders.length > 0) {
    const orderIds = stalePendingManualOrders.map((o) => o.orderId);
    const buyerIds = stalePendingManualOrders.map((o) => o.buyerId);
    const sellerIds = stalePendingManualOrders.map((o) => o.sellerId);

    // Update orders to "completed"
    await walletsDb.collection("Orders").updateMany(
      { orderId: { $in: orderIds } },
      { $set: { status: "completed", statusUpdatedAt: new Date().toISOString() } }
    );

    // Update buyer transactions to "completed"
    await walletsDb.collection("Transactions").updateMany(
      { orderId: { $in: orderIds }, userId: { $in: buyerIds }, type: "ProductPurchase", status: "pending" },
      { $set: { status: "completed" } }
    );

    // Update seller transactions to "pending" (awaiting fund release)
    await walletsDb.collection("Transactions").updateMany(
      { orderId: { $in: orderIds }, userId: { $in: sellerIds }, type: "SoldCodes", status: "completed" },
      { $set: { status: "pending" } }
    );

    console.log(`✅ Backfilled ${stalePendingManualOrders.length} stale manual order(s) to "completed"`);
  }

  // Backfill transaction type values to match enum
  await walletsDb.collection("Transactions").updateMany(
    { type: "Premium subscription" },
    { $set: { type: "PremiumSubscription" } }
  );
  await walletsDb.collection("Transactions").updateMany(
    { type: "Product promotion" },
    { $set: { type: "ProductPromotion" } }
  );
  await walletsDb.collection("Transactions").updateMany(
    { type: "Store promotion" },
    { $set: { type: "StorePromotion" } }
  );
  await walletsDb.collection("Transactions").updateMany(
    { type: "Product purchase" },
    { $set: { type: "ProductPurchase" } }
  );
  await walletsDb.collection("Transactions").updateMany(
    { type: "Sold codes" },
    { $set: { type: "SoldCodes" } }
  );

  // Backfill: normalize legacy 16-byte-IV encrypted product codes to standard 12-byte-IV payloads.
  // Idempotent: only targets code entries with 32-hex IV prefix (legacy format).
  const legacyEncryptedCodePattern = /^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;
  const productsCursor = catalogsDb
    .collection("Products")
    .find({
      $or: [
        {
          availableCodes: {
            $elemMatch: {
              $type: "string",
              $regex: legacyEncryptedCodePattern,
            },
          },
        },
        {
          soldCodes: {
            $elemMatch: {
              $type: "string",
              $regex: legacyEncryptedCodePattern,
            },
          },
        },
      ],
    })
    .project({ _id: 1, availableCodes: 1, soldCodes: 1 });

  const productBulkOps: any[] = [];
  let normalizedProductsCount = 0;

  const normalizeCodes = (codes: unknown): { values: string[]; changed: boolean } => {
    const arr = Array.isArray(codes) ? codes : [];
    let changed = false;

    const values = arr.map((entry) => {
      if (typeof entry !== "string") return String(entry ?? "");
      if (!legacyEncryptedCodePattern.test(entry)) return entry;

      const plain = decryptCodeOrPlain(entry);
      if (plain === entry) return entry;

      changed = true;
      return encryptCode(plain);
    });

    return { values, changed };
  };

  for await (const product of productsCursor) {
    const nextAvailable = normalizeCodes(product.availableCodes);
    const nextSold = normalizeCodes(product.soldCodes);

    if (!nextAvailable.changed && !nextSold.changed) continue;

    productBulkOps.push({
      updateOne: {
        filter: { _id: product._id as any },
        update: {
          $set: {
            availableCodes: nextAvailable.values,
            soldCodes: nextSold.values,
          },
        },
      },
    });
    normalizedProductsCount += 1;

    if (productBulkOps.length >= 500) {
      await catalogsDb.collection("Products").bulkWrite(productBulkOps, { ordered: false });
      productBulkOps.length = 0;
    }
  }

  if (productBulkOps.length > 0) {
    await catalogsDb.collection("Products").bulkWrite(productBulkOps, { ordered: false });
  }

  if (normalizedProductsCount > 0) {
    console.log(`✅ Normalized encrypted codes to 12-byte IV for ${normalizedProductsCount} product(s)`);
  }

  // Backfill: decrypt legacy encrypted purchased codes stored on orders.
  // Idempotent: only targets orders whose code entries still match encrypted payload format.
  const encryptedCodePattern = /^[0-9a-fA-F]{24,32}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;
  const encryptedOrdersCursor = walletsDb
    .collection("Orders")
    .find({
      codes: {
        $elemMatch: {
          $type: "string",
          $regex: encryptedCodePattern,
        },
      },
    })
    .project({ _id: 1, codes: 1 });

  const bulkOps: any[] = [];
  let decryptedOrdersCount = 0;

  for await (const order of encryptedOrdersCursor) {
    const rawCodes = Array.isArray(order.codes) ? order.codes : [];
    const nextCodes = rawCodes.map((code) => {
      if (typeof code !== "string") return code;
      return decryptCodeOrPlain(code);
    });

    const hasChanges = nextCodes.some((code, idx) => code !== rawCodes[idx]);
    if (!hasChanges) continue;

    bulkOps.push({
      updateOne: {
        filter: { _id: order._id as any },
        update: { $set: { codes: nextCodes } },
      },
    });
    decryptedOrdersCount += 1;

    if (bulkOps.length >= 500) {
      await walletsDb.collection("Orders").bulkWrite(bulkOps, { ordered: false });
      bulkOps.length = 0;
    }
  }

  if (bulkOps.length > 0) {
    await walletsDb.collection("Orders").bulkWrite(bulkOps, { ordered: false });
  }

  if (decryptedOrdersCount > 0) {
    console.log(`✅ Decrypted purchased codes for ${decryptedOrdersCount} order(s)`);
  }

  return db;
}

export function getDB(): Db {
  if (!db) {
    throw new Error("Database not initialized. Call connectDB() first.");
  }
  return db;
}

export function getWalletsDB(): Db {
  if (!walletsDb) {
    throw new Error("Database not initialized. Call connectDB() first.");
  }
  return walletsDb;
}

export function getCatalogsDB(): Db {
  if (!catalogsDb) {
    throw new Error("Database not initialized. Call connectDB() first.");
  }
  return catalogsDb;
}

export async function closeDB(): Promise<void> {
  if (client) {
    await client.close();
    console.log("🔌 MongoDB connection closed");
  }
}
