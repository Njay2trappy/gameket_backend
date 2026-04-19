import { MongoClient, Db } from "mongodb";

let client: MongoClient;
let db: Db;
let walletsDb: Db;
let catalogsDb: Db;

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

  // Backfill type for existing products that don't have it
  await catalogsDb.collection("Products").updateMany(
    { type: { $exists: false } },
    { $set: { type: "Auto" } }
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
