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
