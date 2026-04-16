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
  password: string;
  twoFactorAuth: boolean;
  lastLogin: string | null;
  tokenVersion: number;
}

export interface PaymentMethod {
  name: string;
  address: string;
  isActive: boolean;
}

export interface Balance {
  userId: string;
  availableBalance: number;
  suspendedBalance: number;
  methods: PaymentMethod[];
}
