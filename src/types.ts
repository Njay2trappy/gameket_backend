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
  paymentMethod: string;
  paymentLink: string;
  amount: number;
  fee: number;
  totalCharged: number;
  status: string;
}

export interface Review {
  reviewerId: string;
  rating: number;
  comment: string;
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
  isPromoted: boolean;
  type: string;
  totalSales: number;
  positiveReviews: number;
  negativeReviews: number;
  reviews: Review[];
  createdAt: string;
}

export interface PromotedStore {
  userId: string;
  storeId: string;
  amount: number;
  campaignStart: string;
  campaignEnd: string;
  createdAt: string;
}
