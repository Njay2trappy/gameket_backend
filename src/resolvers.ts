import { GraphQLScalarType, Kind } from "graphql";
import { authQueries, authMutations } from "./modules/auth/resolvers.js";
import { usersQueries, usersMutations, userFieldResolvers } from "./modules/users/resolvers.js";
import { walletsQueries, walletsMutations } from "./modules/wallets/resolvers.js";
import { catalogsQueries, catalogsMutations } from "./modules/catalogs/resolvers.js";
import { adminQueries, adminMutations } from "./modules/admin/resolvers.js";

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

