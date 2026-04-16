import { authTypeDefs } from "./modules/auth/schema.js";
import { usersTypeDefs } from "./modules/users/schema.js";
import { walletsTypeDefs } from "./modules/wallets/schema.js";

const baseTypeDefs = `#graphql
  type User {
    id: ID!
    username: String!
    email: String!
    country: String!
    isActive: Boolean!
    isVerified: Boolean!
    isPremium: Boolean!
    twoFactorAuth: Boolean!
    rank: Int!
    registered: String!
    isStore: Boolean!
    avatar: String
  }

  type Query {
    _empty: Boolean
  }

  type Mutation {
    _empty: Boolean
  }
`;

export const typeDefs = [baseTypeDefs, authTypeDefs, usersTypeDefs, walletsTypeDefs];

