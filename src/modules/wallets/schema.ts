export const walletsTypeDefs = `#graphql
  enum TransactionType {
    Deposit
    PremiumSubscription
    ProductPromotion
    StorePromotion
    ProductPurchase
    SoldCodes
    Refund
    PartialRefund
    Withdrawal
  }

  enum TransactionStatus {
    pending
    completed
    failed
    refunded
  }

  enum WithdrawalStatus {
    pending
    approved
    declined
  }

  enum TransactionMethod {
    Webcheckout
    balance
  }

  enum OrderType {
    userpurchase
    anonpurchase
  }

  enum OrderStatus {
    pending
    completed
    disputed
    refunded
    partially_refunded
    failed
  }

  enum OrderAction {
    buy
    sell
  }

  type OrderDetails {
    orderId: ID!
    buyerId: String!
    buyerName: String!
    sellerId: String!
    sellerName: String!
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
    isReleased: Boolean!
    reviewType: ReviewType
    disputeReason: String
    createdAt: String!
    releasedAt: String!
    store: StoreDetails
    transaction: TransactionDetails
    refundOffer: RefundOfferDetails
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

  type GetOrderResponse {
    code: Int!
    success: Boolean!
    message: String!
    order: OrderDetails
  }

  enum UserProductAnalysisAction {
    sold
    purchased
  }

  type UserTopProductAnalysis {
    productId: ID!
    productName: String!
    category: String!
    quantity: Int!
    action: UserProductAnalysisAction!
  }

  type UserTopCountryAnalysis {
    country: String!
    interactionCount: Int!
  }

  type BalanceChangePoint {
    date: String!
    value: Float!
  }

  type ProfitAnalysisData {
    last7Days: [BalanceChangePoint!]!
    last30Days: [BalanceChangePoint!]!
    allTime: [BalanceChangePoint!]!
  }

  type ReleasableOrderAnalysis {
    orderId: ID!
    productId: String!
    productName: String!
    category: String!
    quantity: Int!
    amount: Float!
    releaseAt: String!
    hoursUntilRelease: Float!
  }

  type ReleasableFundsForecast {
    unlockNext24Hours: Float!
    unlockNext3Days: Float!
    unlockNext7Days: Float!
    orders: [ReleasableOrderAnalysis!]!
  }

  type GetUserAnalysisResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    topProducts: [UserTopProductAnalysis!]!
    topCountries: [UserTopCountryAnalysis!]!
    profitAnalysis: ProfitAnalysisData!
    releasableFunds: ReleasableFundsForecast!
  }

  enum NotificationSeenSection {
    all
    orders
    transactions
    conflicts
  }

  enum ConflictNotificationIcon {
    NEW_MESSAGE
    IN_PROGRESS
    RESOLVED
    CLOSED
  }

  type ConflictNotificationItem {
    disputeId: ID!
    orderId: String!
    status: DisputeStatus!
    unreadMessagesCount: Int!
    lastMessage: String
    lastMessageAt: String
    icon: ConflictNotificationIcon!
  }

  type UserNotificationSummary {
    badgeCount: Int!
    hasUnread: Boolean!
    totalUnreadCount: Int!
    newOrdersCount: Int!
    newTransactionsCount: Int!
    newConflictMessagesCount: Int!
    conflictNotifications: [ConflictNotificationItem!]!
    ordersSeenAt: String!
    transactionsSeenAt: String!
    conflictSeenAt: String!
  }

  type UserNotificationSummaryResponse {
    code: Int!
    success: Boolean!
    message: String!
    summary: UserNotificationSummary!
  }

  extend type Query {
    getUserWallets: GetUserWalletsResponse!
    getUserTransactions(id: ID, first: Int, after: String, last: Int, before: String): GetUserTransactionsResponse!
    getUserOrders(id: ID, first: Int, after: String, last: Int, before: String): GetUserOrdersResponse!
    getUserAnalysis: GetUserAnalysisResponse!
    getUserNotificationSummary: UserNotificationSummaryResponse!
    getOrder(id: ID!): GetOrderResponse!
    getUserReviews(first: Int, after: String, last: Int, before: String): GetUserReviewsResponse!
    getStoreReviews(storeId: ID!, category: String!, first: Int, after: String, last: Int, before: String): GetStoreReviewsResponse!
    getUserStoreReviews(first: Int, after: String, last: Int, before: String): GetUserStoreReviewsResponse!
    getUserDisputes(first: Int, after: String, last: Int, before: String): GetUserDisputesResponse!
    getUserDisputeDetails(disputeId: ID!, first: Int, after: String, last: Int, before: String): GetUserDisputeDetailsResponse!
    getUserRefundOffers(first: Int, after: String, last: Int, before: String): GetUserRefundOffersResponse!
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

  type WithdrawalDetails {
    withdrawalId: ID!
    transactionId: String!
    userId: String!
    amount: Float!
    serviceFee: Float!
    networkFee: Float!
    totalFee: Float!
    payoutAmount: Float!
    status: WithdrawalStatus!
    wallet: PaymentMethod!
    createdAt: String!
    processedAt: String
  }

  type UserWithdrawResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    withdrawal: WithdrawalDetails
  }

  type BuyCodesbyAnonResponse {
    code: Int!
    success: Boolean!
    message: String!
    order: OrderDetails
    deposit: DepositDetails
    payId: String
    paymentLink: String
  }

  enum ReviewType {
    positive
    negative
  }

  type ReviewDetails {
    reviewerName: String!
    orderId: String!
    type: ReviewType!
    review: String!
    date: String!
  }

  type ReviewOrderResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    review: ReviewDetails
  }

  type ReviewEdge {
    cursor: String!
    node: ReviewDetails!
  }

  type ReviewConnection {
    edges: [ReviewEdge!]!
    pageInfo: ReviewPageInfo!
  }

  type ReviewPageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type GetUserReviewsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    reviews: ReviewConnection
  }

  type GetStoreReviewsResponse {
    code: Int!
    success: Boolean!
    message: String!
    reviews: ReviewConnection
  }

  type GetUserStoreReviewsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    reviews: ReviewConnection
  }

  extend type Mutation {
    userDeposit(input: UserDepositInput!): UserDepositResponse!
    addWalletOptions(input: AddWalletOptionInput!): AddWalletOptionResponse!
    userWithdraw(amount: Float!): UserWithdrawResponse!
    markNotificationAsSeen(section: NotificationSeenSection = all): UserNotificationSummaryResponse!
    markConflictNotificationAsSeen(disputeId: ID!): UserNotificationSummaryResponse!
    buyCodesbyUser(productId: ID!, quantity: Int!): BuyCodesResponse!
    buyCodesbyAnon(productId: ID!, quantity: Int!, email: String!): BuyCodesbyAnonResponse!
    reviewOrder(orderId: ID!, type: ReviewType!): ReviewOrderResponse!
    refundOrder(orderId: ID!, quantity: Int!): RefundOrderResponse!
    disputeOrder(orderId: ID!, reason: String): DisputeOrderResponse!
    updateDispute(disputeId: ID!, message: String!): UpdateDisputeResponse!
    closeDispute(disputeId: ID!): CloseDisputeResponse!
    acceptRefund(refundId: ID!): AcceptRefundResponse!
    declineRefund(refundId: ID!): DeclineRefundResponse!
  }

  type DisputeOrderResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    dispute: DisputeDetails
  }

  type DisputeDetails {
    disputeId: ID!
    orderId: String!
    buyerId: String!
    sellerId: String!
    storeId: String!
    reason: String
    status: DisputeStatus!
    messages: DisputeMessageConnection
    createdAt: String!
    order: OrderDetails
  }

  enum DisputeStatus {
    open
    under_review
    resolved
    closed
  }

  type DisputeMessageDetails {
    senderId: String!
    senderName: String!
    message: String!
    sentAt: String!
  }

  type DisputeMessageEdge {
    cursor: String!
    node: DisputeMessageDetails!
  }

  type DisputeMessageConnection {
    edges: [DisputeMessageEdge!]!
    pageInfo: DisputeMessagePageInfo!
  }

  type DisputeMessagePageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type DisputeEdge {
    cursor: String!
    node: DisputeDetails!
  }

  type DisputeConnection {
    edges: [DisputeEdge!]!
    pageInfo: DisputePageInfo!
  }

  type DisputePageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type GetUserDisputesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    disputes: DisputeConnection
  }

  type GetUserDisputeDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    dispute: DisputeDetails
  }

  type UpdateDisputeResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    dispute: DisputeDetails
  }

  type CloseDisputeResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    dispute: DisputeDetails
  }

  type RefundOrderResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    order: OrderDetails
    refundOffer: RefundOfferDetails
  }

  enum RefundOfferStatus {
    pending
    accepted
    declined
  }

  type RefundOfferDetails {
    refundId: ID!
    orderId: String!
    buyerId: String!
    sellerId: String!
    storeId: String!
    quantity: Int!
    refundAmount: Float!
    sellerDeduction: Float!
    status: RefundOfferStatus!
    createdAt: String!
    order: OrderDetails
  }

  type RefundOfferEdge {
    cursor: String!
    node: RefundOfferDetails!
  }

  type RefundOfferConnection {
    edges: [RefundOfferEdge!]!
    pageInfo: RefundOfferPageInfo!
  }

  type RefundOfferPageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type GetUserRefundOffersResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    refundOffers: RefundOfferConnection
  }

  type AcceptRefundResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    refundOffer: RefundOfferDetails
  }

  type DeclineRefundResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    refundOffer: RefundOfferDetails
  }
`;
