import crypto from "crypto";
import { allGroups } from "../../../data/categories/index.js";
import { GraphQLError } from "graphql";
import { v4 as uuidv4 } from "uuid";
import { getCatalogsDB, getDB } from "../../db.js";
import type { Product, Store, User } from "../../types.js";
import type { Context } from "../../index.js";
import countryData from "../../../data/country.json" with { type: "json" };

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
const ALGORITHM = "aes-256-gcm";

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText: string): string {
  const [ivHex, authTagHex, ciphertext] = encryptedText.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const validRegions = new Set([
  ...Object.values(countryData.countries).map((c) => c.toLowerCase()),
  ...Object.values(countryData.regions).map((r) => r.toLowerCase()),
]);

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString("base64");
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  return parseInt(decoded.replace("cursor:", ""), 10);
}

export const catalogsQueries = {
  getUserProducts: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can view their products", products: null };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 403, success: false, message: "You must have a store to view products", products: null };
    }

    if (!store.isActive) {
      return { code: 403, success: false, message: "Your store is not active", products: null };
    }

    const allProducts = await catalogsDB.collection<Product>("Products").find({ userId }).toArray();
    const total = allProducts.length;

    let start = 0;
    let end = total;

    if (first != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + first, total);
    } else if (first != null) {
      end = Math.min(first, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allProducts.slice(start, end);

    const edges = sliced.map((p, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        productId: p.productId,
        catalog: p.catalog,
        category: p.category,
        region: p.region,
        name: p.name,
        description: p.description,
        marketPrice: p.marketPrice,
        price: p.price,
        discount: p.discount,
        isActive: p.isActive,
        available: p.available,
        sold: p.sold,
        createdAt: p.createdAt,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} product(s) found`,
      products: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  viewProductCodes: async (
    _: unknown,
    { productId, first, after, last, before }: { productId: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can view product codes", availableCodes: null, soldCodes: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", availableCodes: null, soldCodes: null };
    }

    const allAvailable = product.availableCodes.map((c) => decrypt(c));
    const allSold = (product.soldCodes || []).map((c) => decrypt(c));

    function paginateCodes(codes: string[]) {
      const total = codes.length;
      let start = 0;
      let end = total;

      if (first != null && after) {
        start = decodeCursor(after) + 1;
        end = Math.min(start + first, total);
      } else if (first != null) {
        end = Math.min(first, total);
      } else if (last != null && before) {
        end = decodeCursor(before);
        start = Math.max(end - last, 0);
      } else if (last != null) {
        start = Math.max(total - last, 0);
      }

      const sliced = codes.slice(start, end);

      const edges = sliced.map((code, i) => ({
        cursor: encodeCursor(start + i),
        node: code,
      }));

      return {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      };
    }

    return {
      code: 200,
      success: true,
      message: `${allAvailable.length} available, ${allSold.length} sold`,
      availableCodes: paginateCodes(allAvailable),
      soldCodes: paginateCodes(allSold),
    };
  },

  fetchCatalog: async (
    _: unknown,
    { name, category, first, after, last, before }: { name: string; category?: string; first?: number; after?: string; last?: number; before?: string }
  ) => {
    const searchName = name.trim().toLowerCase();

    if (searchName.length === 0) {
      return { code: 400, success: false, message: "Name is required", group: null, item: null };
    }

    const group = allGroups.find(
      (g) => g.title.toLowerCase() === searchName
    );

    if (!group) {
      return { code: 404, success: false, message: "Catalog not found", group: null, item: null };
    }

    // If category provided, return single item
    if (category && category.trim().length > 0) {
      const searchCategory = category.trim().toLowerCase();
      const found = group.categories.find(
        (c) => c.name.toLowerCase() === searchCategory
      );

      if (!found) {
        return { code: 404, success: false, message: "Category not found in this catalog", group: null, item: null };
      }

      return {
        code: 200,
        success: true,
        message: "Category retrieved successfully",
        group: null,
        item: {
          slug: found.slug,
          name: found.name,
          groupId: group.id,
          groupTitle: group.title,
        },
      };
    }

    // Paginate categories
    const allCategories = group.categories;
    const totalCount = allCategories.length;

    let startIndex: number;
    let endIndex: number;

    if (before) {
      // Backward pagination
      const beforeIndex = decodeCursor(before);
      const limit = last ?? 20;
      startIndex = Math.max(0, beforeIndex - limit);
      endIndex = beforeIndex;
    } else {
      // Forward pagination
      const limit = first ?? 20;
      startIndex = after ? decodeCursor(after) + 1 : 0;
      endIndex = startIndex + limit;
    }

    const sliced = allCategories.slice(startIndex, endIndex);

    const edges = sliced.map((cat, i) => ({
      cursor: encodeCursor(startIndex + i),
      node: {
        slug: cat.slug,
        name: cat.name,
        groupId: group.id,
        groupTitle: group.title,
      },
    }));

    const lastIndex = startIndex + sliced.length - 1;

    return {
      code: 200,
      success: true,
      message: "Catalog retrieved successfully",
      group: {
        id: group.id,
        title: group.title,
        icon: group.icon,
        categories: {
          edges,
          pageInfo: {
            hasNextPage: lastIndex < totalCount - 1,
            hasPreviousPage: startIndex > 0,
            startCursor: edges.length > 0 ? edges[0].cursor : null,
            endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
            fetchedCount: sliced.length,
            remainingCount: Math.max(0, totalCount - (startIndex + sliced.length)),
          },
          totalCount,
        },
      },
      item: null,
    };
  },
};

export const catalogsMutations = {
  addProduct: async (
    _: unknown,
    { input }: { input: { catalog: string; category: string; region: string; name: string; description: string; marketPrice: number; price: number } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    // Verify user is a seller
    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can create products", product: null };
    }

    // Verify user has a store
    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 403, success: false, message: "You must have a store to add products", product: null };
    }

    if (!store.isActive) {
      return { code: 403, success: false, message: "Your store is not active", product: null };
    }

    const catalog = input.catalog.trim();
    const category = input.category.trim();
    const region = input.region.trim();
    const name = input.name.trim();
    const description = input.description.trim();
    const { marketPrice, price } = input;

    // Validate required fields
    if (catalog.length === 0) {
      return { code: 400, success: false, message: "Catalog is required", product: null };
    }
    if (category.length === 0) {
      return { code: 400, success: false, message: "Category is required", product: null };
    }
    if (region.length === 0) {
      return { code: 400, success: false, message: "Region is required", product: null };
    }
    if (name.length === 0) {
      return { code: 400, success: false, message: "Name is required", product: null };
    }
    if (name.length > 100) {
      return { code: 400, success: false, message: "Name must be at most 100 characters", product: null };
    }
    if (description.length === 0) {
      return { code: 400, success: false, message: "Description is required", product: null };
    }
    if (description.length > 500) {
      return { code: 400, success: false, message: "Description must be at most 500 characters", product: null };
    }
    if (marketPrice <= 0) {
      return { code: 400, success: false, message: "Market price must be greater than 0", product: null };
    }
    if (price <= 0) {
      return { code: 400, success: false, message: "Price must be greater than 0", product: null };
    }
    if (price > marketPrice) {
      return { code: 400, success: false, message: "Price cannot exceed market price", product: null };
    }

    // Validate catalog exists
    const group = allGroups.find(
      (g) => g.title.toLowerCase() === catalog.toLowerCase()
    );
    if (!group) {
      return { code: 400, success: false, message: "Invalid catalog", product: null };
    }

    // Validate category exists in catalog
    const categoryExists = group.categories.some(
      (c) => c.name.toLowerCase() === category.toLowerCase()
    );
    if (!categoryExists) {
      return { code: 400, success: false, message: "Invalid category for this catalog", product: null };
    }

    // Validate region
    if (!validRegions.has(region.toLowerCase())) {
      return { code: 400, success: false, message: "Invalid region or country", product: null };
    }

    // Calculate discount
    const discount = parseFloat((((marketPrice - price) / marketPrice) * 100).toFixed(2));

    const product: Product = {
      userId,
      storeId: store.storeId,
      productId: uuidv4(),
      catalog,
      category,
      region,
      name,
      description,
      marketPrice: parseFloat(marketPrice.toFixed(2)),
      price: parseFloat(price.toFixed(2)),
      discount,
      isActive: false,
      available: 0,
      sold: 0,
      availableCodes: [],
      soldCodes: [],
      createdAt: new Date().toISOString(),
    };

    await catalogsDB.collection<Product>("Products").insertOne(product);

    return {
      code: 201,
      success: true,
      message: "Product added successfully",
      product: {
        productId: product.productId,
        catalog: product.catalog,
        category: product.category,
        region: product.region,
        name: product.name,
        description: product.description,
        marketPrice: product.marketPrice,
        price: product.price,
        discount: product.discount,
        isActive: product.isActive,
        available: product.available,
        sold: product.sold,
        createdAt: product.createdAt,
      },
    };
  },

  addProductCodes: async (
    _: unknown,
    { input }: { input: { productId: string; codes: string[] } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const userId = context.user.userId;
    const { productId, codes } = input;

    if (!codes.length) {
      return { code: 400, success: false, message: "Codes array cannot be empty", available: null };
    }

    const catalogsDB = getCatalogsDB();

    // Verify product belongs to user
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", available: null };
    }

    // Encrypt each code
    const encryptedCodes = codes.map((code) => encrypt(code.trim()));

    // Push codes and increment available count
    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId },
      {
        $push: { availableCodes: { $each: encryptedCodes } },
        $inc: { available: encryptedCodes.length },
        $set: { isActive: true },
      }
    );

    return {
      code: 200,
      success: true,
      message: `${encryptedCodes.length} code(s) added successfully`,
      available: product.available + encryptedCodes.length,
    };
  },

  deleteProductCodes: async (
    _: unknown,
    { input }: { input: { productId: string; codes: string[] } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const userId = context.user.userId;
    const { productId, codes } = input;

    if (!codes.length) {
      return { code: 400, success: false, message: "Codes array cannot be empty", available: null };
    }

    const catalogsDB = getCatalogsDB();

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", available: null };
    }

    if (!product.availableCodes.length) {
      return { code: 400, success: false, message: "No codes available to delete", available: product.available };
    }

    // Decrypt stored codes to find matches
    const codesToDelete = new Set(codes.map((c) => c.trim()));
    const toRemove: string[] = [];
    const toKeep: string[] = [];

    for (const encrypted of product.availableCodes) {
      const decrypted = decrypt(encrypted);
      if (codesToDelete.has(decrypted)) {
        toRemove.push(encrypted);
        codesToDelete.delete(decrypted);
      } else {
        toKeep.push(encrypted);
      }
    }

    if (!toRemove.length) {
      return { code: 404, success: false, message: "None of the provided codes were found", available: product.available };
    }

    const newAvailable = product.available - toRemove.length;

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId },
      {
        $set: { availableCodes: toKeep, available: newAvailable, isActive: newAvailable > 0 },
      }
    );

    return {
      code: 200,
      success: true,
      message: `${toRemove.length} code(s) deleted successfully`,
      available: newAvailable,
    };
  },

  updateProduct: async (
    _: unknown,
    { input }: { input: { productId: string; description?: string; marketPrice?: number; price?: number } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can update products", product: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId: input.productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", product: null };
    }

    const updates: Record<string, unknown> = {};

    if (input.description != null) {
      const description = input.description.trim();
      if (description.length === 0) {
        return { code: 400, success: false, message: "Description cannot be empty", product: null };
      }
      if (description.length > 500) {
        return { code: 400, success: false, message: "Description must be at most 500 characters", product: null };
      }
      updates.description = description;
    }

    if (input.marketPrice != null) {
      if (input.marketPrice <= 0) {
        return { code: 400, success: false, message: "Market price must be greater than 0", product: null };
      }
      updates.marketPrice = parseFloat(input.marketPrice.toFixed(2));
    }

    if (input.price != null) {
      if (input.price <= 0) {
        return { code: 400, success: false, message: "Price must be greater than 0", product: null };
      }
      updates.price = parseFloat(input.price.toFixed(2));
    }

    if (Object.keys(updates).length === 0) {
      return { code: 400, success: false, message: "No fields to update", product: null };
    }

    // Recalculate discount with final values
    const finalMarketPrice = (updates.marketPrice as number) ?? product.marketPrice;
    const finalPrice = (updates.price as number) ?? product.price;

    if (finalPrice > finalMarketPrice) {
      return { code: 400, success: false, message: "Price cannot exceed market price", product: null };
    }

    updates.discount = parseFloat((((finalMarketPrice - finalPrice) / finalMarketPrice) * 100).toFixed(2));

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId: input.productId, userId },
      { $set: updates }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId: input.productId, userId });

    return {
      code: 200,
      success: true,
      message: "Product updated successfully",
      product: {
        productId: updated!.productId,
        catalog: updated!.catalog,
        category: updated!.category,
        region: updated!.region,
        name: updated!.name,
        description: updated!.description,
        marketPrice: updated!.marketPrice,
        price: updated!.price,
        discount: updated!.discount,
        isActive: updated!.isActive,
        available: updated!.available,
        sold: updated!.sold,
        createdAt: updated!.createdAt,
      },
    };
  },

  deleteProduct: async (
    _: unknown,
    { productId }: { productId: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can delete products" };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you" };
    }

    await catalogsDB.collection<Product>("Products").deleteOne({ productId, userId });

    return {
      code: 200,
      success: true,
      message: "Product deleted successfully",
    };
  },
};
