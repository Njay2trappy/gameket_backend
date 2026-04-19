export interface User {
  id: string;
  username: string;
  email: string;
  country: string;
  isActive: boolean;
  isVerified: boolean;
  isPremium: boolean;
  rank: number;
  registered: string;
  isStore: boolean;
  avatar: string | null;
}

export interface Account {
  userId: string;
  email: string;
  password: string | null;
  authProvider: "email" | "google";
  twoFactorAuth: boolean;
  lastLogin: string | null;
  tokenVersion: number;
  otp: string | null;
  otpExpiresAt: string | null;
}

export interface PaymentMethod {
  name: string;
  value: string;
  network: string;
  isActive: boolean;
}

export interface Balance {
  userId: string;
  availableBalance: number;
  suspendedBalance: number;
  methods: PaymentMethod[];
}

export interface Deposit {
  userId: string;
  payId: string;
  transactionId: string;
  orderId?: string;
  paymentMethod: string;
  paymentLink: string;
  amount: number;
  fee: number;
  totalCharged: number;
  status: string;
  type: string;
  // codepurchase-specific fields
  sellerId?: string;
  storeId?: string;
  productId?: string;
  quantity?: number;
  buyerName?: string;
}

export interface Review {
  reviewerId: string;
  orderId: string;
  type: string;
  review: string;
  date: string;
}

export interface Premium {
  userId: string;
  subscribedAt: string;
  expiresAt: string;
  isActive: boolean;
}

export interface Transaction {
  userId: string;
  id: string;
  type: string;
  status: string;
  method: string;
  amount: number;
  createdAt: string;
}

export interface Product {
  userId: string;
  storeId: string;
  productId: string;
  catalog: string;
  category: string;
  region: string;
  name: string;
  description: string;
  marketPrice: number;
  price: number;
  discount: number;
  isActive: boolean;
  isPromoted: boolean;
  available: number;
  sold: number;
  type: "Auto" | "Manual";
  availableCodes: string[];
  soldCodes: string[];
  createdAt: string;
}

export interface PromotedProduct {
  userId: string;
  storeId: string;
  productId: string;
  amount: number;
  campaignStart: string;
  campaignEnd: string;
  createdAt: string;
}

export interface Store {
  userId: string;
  storeId: string;
  storeName: string;
  isActive: boolean;
  isApproved: boolean;
  approveStatus: string | null;
  isPromoted: boolean;
  type: string;
  totalSales: number;
  positiveReviews: number;
  negativeReviews: number;
  reviews: Review[];
  createdAt: string;
  requestCount: number;
}

export interface PromotedStore {
  userId: string;
  storeId: string;
  amount: number;
  campaignStart: string;
  campaignEnd: string;
  createdAt: string;
}

export interface Blacklist {
  storeId: string;
  userId: string;
  blockedBy: string;
  createdAt: string;
}

export interface VerificationRequest {
  userId: string;
  storeId: string;
  storeName: string;
  surname: string;
  otherNames: string;
  gender: string;
  dateOfBirth: string;
  address: string;
  nationality: string;
  identification: string;
  proofPerson: string;
  submittedAt: string;
}

export interface Order {
  orderId: string;
  buyerId: string;
  buyerName: string;
  sellerId: string;
  storeId: string;
  productId: string;
  buyerTransactionId: string;
  sellerTransactionId: string;
  codes: string[];
  quantity: number;
  amount: number;
  fee: number;
  totalAmount: number;
  status: string;
  type: string;
  isReviewed: boolean;
  reviewType: string | null;
  isReleased: boolean;
  disputeReason: string | null;
  createdAt: string;
  releasedAt: string;
}

export interface DisputeMessage {
  senderId: string;
  senderName: string;
  message: string;
  sentAt: string;
}

export interface Dispute {
  disputeId: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  storeId: string;
  reason: string | null;
  status: string;
  messages: DisputeMessage[];
  createdAt: string;
}

export interface RefundOffer {
  refundId: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  storeId: string;
  quantity: number;
  refundAmount: number;
  sellerDeduction: number;
  status: string;
  createdAt: string;
}
