import { allGroups } from "../../../data/categories/index.js";
import { GraphQLError } from "graphql";
import { v4 as uuidv4 } from "uuid";
import { getCatalogsDB, getDB } from "../../db.js";
import type { Product, Store, User } from "../../types.js";
import type { Context } from "../../index.js";
import countryData from "../../../data/country.json" with { type: "json" };

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
        createdAt: product.createdAt,
      },
    };
  },
};
