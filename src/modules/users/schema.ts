export const usersTypeDefs = `#graphql
  type PaymentMethod {
    name: String!
    address: String!
    isActive: Boolean!
  }

  type Wallet {
    availableBalance: Float!
    suspendedBalance: Float!
    methods: [PaymentMethod!]!
  }

  type UserDetails {
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
    wallet: Wallet
  }

  type UserDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: UserDetails
  }

  extend type Query {
    getUserDetails: UserDetailsResponse!
  }
`;
