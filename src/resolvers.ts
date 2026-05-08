import { GraphQLScalarType, Kind } from "graphql";
import { authQueries, authMutations } from "./modules/auth/resolvers.js";
import { usersQueries, usersMutations, userFieldResolvers } from "./modules/users/resolvers.js";
import { walletsQueries, walletsMutations } from "./modules/wallets/resolvers.js";
import { catalogsQueries, catalogsMutations } from "./modules/catalogs/resolvers.js";
import { adminQueries, adminMutations } from "./modules/admin/resolvers.js";
import { getCatalogsDB } from "./db.js";
import type { Product, Store } from "./types.js";

const DateScalar = new GraphQLScalarType({
  name: "Date",
  description: "ISO-8601 date string",
  serialize(value: unknown) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value;
    throw new Error("Date scalar: cannot serialize non-date value");
  },
  parseValue(value: unknown) {
    if (typeof value !== "string") throw new Error("Date scalar: value must be a string");
    const date = new Date(value);
    if (isNaN(date.getTime())) throw new Error("Date scalar: invalid date string");
    return date;
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING) {
      const date = new Date(ast.value);
      if (isNaN(date.getTime())) throw new Error("Date scalar: invalid date string");
      return date;
    }
    throw new Error("Date scalar: value must be a string");
  },
});

export const resolvers = {
  Date: DateScalar,
  User: userFieldResolvers,
  ProductDetails: {
    isAPI: async (parent: Record<string, unknown>) => {
      if ("isAPI" in parent) {
        return Boolean(parent.isAPI);
      }

      const productId = typeof parent.productId === "string" ? parent.productId : null;
      if (!productId) return false;

      const catalogsDB = getCatalogsDB();
      const productDoc = await catalogsDB.collection<Product>("Products").findOne(
        { productId },
        { projection: { isAPI: 1 } }
      );

      return Boolean(productDoc?.isAPI);
    },
  },
  GetProductsProductDetails: {
    isAPI: async (parent: Record<string, unknown>) => {
      if ("isAPI" in parent) {
        return Boolean(parent.isAPI);
      }

      const productId = typeof parent.productId === "string" ? parent.productId : null;
      if (!productId) return false;

      const catalogsDB = getCatalogsDB();
      const productDoc = await catalogsDB.collection<Product>("Products").findOne(
        { productId },
        { projection: { isAPI: 1 } }
      );

      return Boolean(productDoc?.isAPI);
    },
  },
  StoreDetails: {
    bio: async (parent: Record<string, unknown>) => {
      if ("bio" in parent) {
        return (parent.bio as string | null) ?? null;
      }

      const storeId = typeof parent.storeId === "string" ? parent.storeId : null;
      if (!storeId) return null;

      const catalogsDB = getCatalogsDB();
      const storeDoc = await catalogsDB.collection<Store>("Stores").findOne(
        { storeId },
        { projection: { bio: 1 } }
      );

      return storeDoc?.bio ?? null;
    },
    storeImage: async (parent: Record<string, unknown>) => {
      if ("storeImage" in parent) {
        return (parent.storeImage as string | null) ?? null;
      }

      const storeId = typeof parent.storeId === "string" ? parent.storeId : null;
      if (!storeId) return null;

      const catalogsDB = getCatalogsDB();
      const storeDoc = await catalogsDB.collection<Store>("Stores").findOne(
        { storeId },
        { projection: { storeImage: 1 } }
      );

      return storeDoc?.storeImage ?? null;
    },
  },

  Query: {
    _empty: () => true,
    ...authQueries,
    ...usersQueries,
    ...walletsQueries,
    ...catalogsQueries,
    ...adminQueries,
  },

  Mutation: {
    ...authMutations,
    ...usersMutations,
    ...walletsMutations,
    ...catalogsMutations,
    ...adminMutations,
  },
};

