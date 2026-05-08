import { authTypeDefs } from "./modules/auth/schema.js";
import { usersTypeDefs } from "./modules/users/schema.js";
import { walletsTypeDefs } from "./modules/wallets/schema.js";
import { catalogsTypeDefs } from "./modules/catalogs/schema.js";
import { adminTypeDefs } from "./modules/admin/schema.js";

const baseTypeDefs = `#graphql
  scalar Date

  type User {
    id: ID!
    username: String!
    email: String!
    deliveryOption: DeliveryOption!
    country: String!
    isActive: Boolean!
    isSuspended: Boolean!
    isVerified: Boolean!
    isPremium: Boolean!
    twoFactorAuth: Boolean!
    rank: Int!
    registered: String!
    isStore: Boolean!
    avatar: String
    store: StoreDetails
    wallet: Wallet
    premium: PremiumDetails
    products: [ProductDetails!]
    transactions: [TransactionDetails!]
  }

  enum DeliveryOption {
    email
    telegram
  }

  type Query {
    _empty: Boolean
  }

  type Mutation {
    _empty: Boolean
  }
`;

export const typeDefs = [baseTypeDefs, authTypeDefs, usersTypeDefs, walletsTypeDefs, catalogsTypeDefs, adminTypeDefs];

