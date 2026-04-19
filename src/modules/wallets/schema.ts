export const walletsTypeDefs = `#graphql
  enum TransactionType {
    Deposit
    PremiumSubscription
    ProductPromotion
    StorePromotion
    ProductPurchase
    SoldCodes
  }

  enum TransactionStatus {
    pending
    completed
    failed
  }

  enum TransactionMethod {
    Webcheckout
    balance
  }

  enum OrderType {
    userpurchase
  }

  enum OrderStatus {
    pending
    completed
    disputed
    refunded
    failed
  }

  enum OrderAction {
    buy
    sell
  }

  type OrderDetails {
    orderId: ID!
    buyerId: String!
    sellerId: String!
    storeId: String!
    product: GetProductsProductDetails
    codes: [String!]!
    amount: Float!
    fee: Float!
    totalAmount: Float!
    status: OrderStatus!
    type: OrderType!
    action: OrderAction!
    isReviewed: Boolean!
    createdAt: String!
    releasedAt: String!
    store: StoreDetails
    transaction: TransactionDetails
  }

  type BuyCodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    order: OrderDetails
    transaction: TransactionDetails
  }

  type PaymentMethod {
    name: String!
    value: String!
    network: String!
    isActive: Boolean!
  }

  type Wallet {
    availableBalance: Float!
    suspendedBalance: Float!
    methods: [PaymentMethod!]!
  }

  input UserDepositInput {
    amount: Float!
  }

  type DepositDetails {
    amount: Float!
    fee: Float!
    totalCharged: Float!
  }

  type UserDepositResponse {
    code: Int!
    success: Boolean!
    message: String!
    id: String
    user: User
    deposit: DepositDetails
    payId: String
    paymentLink: String
  }

  type GetUserWalletsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    wallet: Wallet
  }

  type TransactionDetails {
    id: ID!
    type: TransactionType!
    status: TransactionStatus!
    method: TransactionMethod!
    amount: Float!
    createdAt: String!
  }

  type TransactionEdge {
    cursor: String!
    node: TransactionDetails!
  }

  type TransactionConnection {
    edges: [TransactionEdge!]!
    pageInfo: TransactionPageInfo!
  }

  type TransactionPageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type GetUserTransactionsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    transaction: TransactionDetails
    transactions: TransactionConnection
  }

  type OrderEdge {
    cursor: String!
    node: OrderDetails!
  }

  type OrderConnection {
    edges: [OrderEdge!]!
    pageInfo: OrderPageInfo!
  }

  type OrderPageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type GetUserOrdersResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    order: OrderDetails
    orders: OrderConnection
  }

  extend type Query {
    getUserWallets: GetUserWalletsResponse!
    getUserTransactions(id: ID, first: Int, after: String, last: Int, before: String): GetUserTransactionsResponse!
    getUserOrders(id: ID, first: Int, after: String, last: Int, before: String): GetUserOrdersResponse!
  }

  input AddWalletOptionInput {
    value: String!
  }

  type AddWalletOptionResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    method: PaymentMethod
  }

  extend type Mutation {
    userDeposit(input: UserDepositInput!): UserDepositResponse!
    addWalletOptions(input: AddWalletOptionInput!): AddWalletOptionResponse!
    buyCodesbyUser(productId: ID!, quantity: Int!): BuyCodesResponse!
  }
`;
