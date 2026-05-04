import { v4 as uuidv4 } from "uuid";
import { randomInt, randomBytes, createCipheriv, createDecipheriv, createHash } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { OAuth2Client } from "google-auth-library";
import { GraphQLError } from "graphql";
import { getDB, getWalletsDB, getCatalogsDB } from "../../db.js";
import type { User, Account, Balance, Store } from "../../types.js";
import type { Context } from "../../index.js";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const TWO_FACTOR_ISSUER = (process.env.TWO_FACTOR_ISSUER || "Gameket").trim();

type TwoFactorChallengePayload = {
  purpose: "2fa_login";
  userId: string;
  email: string;
  tokenVersion: number;
};

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("Server configuration error");
  }
  return secret;
};

const getTwoFactorEncryptionKey = (): Buffer => {
  const secretMaterial = process.env.TWO_FACTOR_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secretMaterial) {
    throw new Error("Server configuration error");
  }
  return createHash("sha256").update(secretMaterial).digest();
};

const encryptTwoFactorSecret = (secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTwoFactorEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
};

const decryptTwoFactorSecret = (encryptedSecret: string): string => {
  const parts = encryptedSecret.split(":");
  if (parts.length !== 3) {
    // Backward compatibility if a legacy plain text secret exists.
    return encryptedSecret;
  }

  const [ivPart, authTagPart, payloadPart] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getTwoFactorEncryptionKey(),
    Buffer.from(ivPart, "base64")
  );
  decipher.setAuthTag(Buffer.from(authTagPart, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadPart, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
};

const normalizeTwoFactorCode = (value: string): string => value.replace(/\s+/g, "").trim();
const isValidTwoFactorCode = (value: string): boolean => /^\d{6}$/.test(value);

const hasTwoFactorConfigured = (account: Account): boolean => {
  return Boolean(account.twoFactorAuth && account.twoFactorSecret);
};

const createTwoFactorChallengeToken = (payload: TwoFactorChallengePayload): string => {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "10m" });
};

const decodeTwoFactorChallengeToken = (token: string): TwoFactorChallengePayload | null => {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (
      !decoded ||
      typeof decoded !== "object" ||
      decoded.purpose !== "2fa_login" ||
      typeof decoded.userId !== "string" ||
      typeof decoded.email !== "string" ||
      typeof decoded.tokenVersion !== "number"
    ) {
      return null;
    }

    return {
      purpose: "2fa_login",
      userId: decoded.userId,
      email: decoded.email,
      tokenVersion: decoded.tokenVersion,
    };
  } catch {
    return null;
  }
};

const issueLoginToken = (user: User, tokenVersion: number): string => {
  return jwt.sign(
    { userId: user.id, email: user.email, tokenVersion },
    getJwtSecret(),
    { expiresIn: "1h" }
  );
};

const loginFailureResponse = (code: number, message: string) => ({
  code,
  success: false,
  message,
  token: null,
  user: null,
  requiresTwoFactor: false,
  twoFactorToken: null,
});

export const authQueries = {};

export const authMutations = {
  register: async (
    _: unknown,
    { input }: { input: { email: string; username: string; country: string; password: string } }
  ) => {
    const db = getDB();
    const users = db.collection<User>("users");
    const accounts = db.collection<Account>("accounts");

    const email = input.email.trim().toLowerCase();
    const username = input.username.trim();
    const country = input.country.trim();
    const password = input.password;

    // Validate email format
    if (email.length > 254) {
      return { code: 400, success: false, message: "Email is too long", user: null };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { code: 400, success: false, message: "Invalid email format", user: null };
    }

    // Validate username: max 15 chars, no spaces
    if (username.length === 0) {
      return { code: 400, success: false, message: "Username is required", user: null };
    }
    if (username.length > 15) {
      return { code: 400, success: false, message: "Username must be at most 15 characters", user: null };
    }
    if (/\s/.test(username)) {
      return { code: 400, success: false, message: "Username must not contain spaces", user: null };
    }

    // Block usernames resembling "Gameket" to prevent impersonation
    const normalized = username.toLowerCase().replace(/[^a-z]/g, "");
    if (normalized.includes("gameket") || normalized.includes("gamket") || normalized.includes("gamekets") || normalized.includes("gam3ket") || normalized.includes("gamek3t")) {
      return { code: 400, success: false, message: "This username is not allowed", user: null };
    }

    // Validate country
    if (country.length === 0) {
      return { code: 400, success: false, message: "Country is required", user: null };
    }
    if (country.length > 100) {
      return { code: 400, success: false, message: "Country name is too long", user: null };
    }

    // Validate password
    if (password.length < 8) {
      return { code: 400, success: false, message: "Password must be at least 8 characters", user: null };
    }
    if (password.length > 128) {
      return { code: 400, success: false, message: "Password must be at most 128 characters", user: null };
    }
    if (!/[A-Z]/.test(password)) {
      return { code: 400, success: false, message: "Password must contain at least one uppercase letter", user: null };
    }
    if (!/[a-z]/.test(password)) {
      return { code: 400, success: false, message: "Password must contain at least one lowercase letter", user: null };
    }
    if (!/[0-9]/.test(password)) {
      return { code: 400, success: false, message: "Password must contain at least one number", user: null };
    }

    // Check uniqueness
    if (await accounts.findOne({ email })) {
      return { code: 400, success: false, message: "Invalid registration details", user: null };
    }
    if (await users.findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } })) {
      return { code: 400, success: false, message: "Invalid registration details", user: null };
    }

    const userId = uuidv4();
    const registered = new Date().toISOString().split("T")[0];
    const hashedPassword = await bcrypt.hash(password, 12);

    const user: User = {
      id: userId,
      username,
      email,
      country,
      isActive: true,
      isSuspended: false,
      isVerified: false,
      isPremium: false,
      rank: 1,
      registered,
      isStore: false,
      avatar: null,
    };

    const account: Account = {
      userId,
      email,
      password: hashedPassword,
      authProvider: "email",
      twoFactorAuth: false,
      twoFactorSecret: null,
      twoFactorTempSecret: null,
      twoFactorEnabledAt: null,
      lastLogin: null,
      tokenVersion: 0,
      otp: null,
      otpExpiresAt: null,
    };

    await users.insertOne(user);
    await accounts.insertOne(account);

    // Create wallet balance
    const walletsDb = getWalletsDB();
    const balances = walletsDb.collection<Balance>("Balances");

    const balance: Balance = {
      userId,
      availableBalance: 0,
      suspendedBalance: 0,
      methods: [],
    };

    await balances.insertOne(balance);

    // Create store in Catalogs database
    const catalogsDb = getCatalogsDB();
    const stores = catalogsDb.collection<Store>("Stores");

    const store: Store = {
      userId,
      storeId: uuidv4(),
      storeName: username,
      isActive: true,
      isApproved: false,
      approveStatus: null,
      isPromoted: false,
      type: "basic",
      totalSales: 0,
      positiveReviews: 0,
      negativeReviews: 0,
      reviews: [],
      createdAt: new Date().toISOString(),
      requestCount: 0,
    };

    await stores.insertOne(store);

    // Generate OTP for email verification
    const otp = String(randomInt(100000, 999999));
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await accounts.updateOne(
      { userId },
      { $set: { otp, otpExpiresAt } }
    );

    return { code: 201, success: true, message: "Registration successful. A verification code has been sent to your email.", user: { ...user, twoFactorAuth: false } };
  },

  login: async (
    _: unknown,
    { input }: { input: { email: string; password: string } }
  ) => {
    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const email = input.email.trim().toLowerCase();
    const password = input.password;

    const account = await accounts.findOne({ email });
    if (!account) {
      return loginFailureResponse(401, "Invalid email or password");
    }

    if (account.authProvider === "google") {
      return loginFailureResponse(400, "This email is registered with Google. Please sign in with Google.");
    }

    const valid = await bcrypt.compare(password, account.password || "");
    if (!valid) {
      return loginFailureResponse(401, "Invalid email or password");
    }

    const user = await users.findOne({ id: account.userId });
    if (!user) {
      return loginFailureResponse(401, "Invalid email or password");
    }

    if (hasTwoFactorConfigured(account)) {
      const twoFactorToken = createTwoFactorChallengeToken({
        purpose: "2fa_login",
        userId: user.id,
        email: user.email,
        tokenVersion: account.tokenVersion ?? 0,
      });

      return {
        code: 200,
        success: true,
        message: "Two-factor verification required",
        token: null,
        user: { ...user, twoFactorAuth: true },
        requiresTwoFactor: true,
        twoFactorToken,
      };
    }

    // Increment tokenVersion to invalidate all previous sessions
    const newTokenVersion = (account.tokenVersion ?? 0) + 1;

    await accounts.updateOne(
      { userId: account.userId },
      { $set: { lastLogin: new Date().toISOString(), tokenVersion: newTokenVersion } }
    );

    const token = issueLoginToken(user, newTokenVersion);

    return {
      code: 200,
      success: true,
      message: "Login successful",
      token,
      user: { ...user, twoFactorAuth: account.twoFactorAuth },
      requiresTwoFactor: false,
      twoFactorToken: null,
    };
  },

  googleSignIn: async (
    _: unknown,
    { input }: { input: { idToken: string; username?: string; country?: string } }
  ) => {
    const ticket = await googleClient.verifyIdToken({
      idToken: input.idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    }).catch(() => null);

    if (!ticket) {
      return loginFailureResponse(401, "Invalid Google token");
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return loginFailureResponse(401, "Invalid Google token");
    }

    const email = payload.email.toLowerCase();

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    // Check if user already exists
    const existingAccount = await accounts.findOne({ email });
    if (existingAccount) {
      if (existingAccount.authProvider !== "google") {
        return loginFailureResponse(400, "This email is registered with email/password. Please login with your password.");
      }

      const user = await users.findOne({ id: existingAccount.userId });
      if (!user) {
        return loginFailureResponse(401, "Account not found");
      }

      if (hasTwoFactorConfigured(existingAccount)) {
        const twoFactorToken = createTwoFactorChallengeToken({
          purpose: "2fa_login",
          userId: user.id,
          email: user.email,
          tokenVersion: existingAccount.tokenVersion ?? 0,
        });

        return {
          code: 200,
          success: true,
          message: "Two-factor verification required",
          token: null,
          user: { ...user, twoFactorAuth: true },
          requiresTwoFactor: true,
          twoFactorToken,
        };
      }

      const newTokenVersion = (existingAccount.tokenVersion ?? 0) + 1;

      await accounts.updateOne(
        { userId: existingAccount.userId },
        { $set: { lastLogin: new Date().toISOString(), tokenVersion: newTokenVersion } }
      );

      const token = issueLoginToken(user, newTokenVersion);

      return {
        code: 200,
        success: true,
        message: "Login successful",
        token,
        user: { ...user, twoFactorAuth: existingAccount.twoFactorAuth },
        requiresTwoFactor: false,
        twoFactorToken: null,
      };
    }

    // New user — username & country required
    const username = input.username?.trim();
    const country = input.country?.trim();

    if (!username) {
      return loginFailureResponse(400, "Username is required for new accounts");
    }
    if (!country) {
      return loginFailureResponse(400, "Country is required for new accounts");
    }

    // Validate username
    if (username.length > 15) {
      return loginFailureResponse(400, "Username must be at most 15 characters");
    }
    if (/\s/.test(username)) {
      return loginFailureResponse(400, "Username must not contain spaces");
    }

    const normalized = username.toLowerCase().replace(/[^a-z]/g, "");
    if (normalized.includes("gameket") || normalized.includes("gamket") || normalized.includes("gamekets") || normalized.includes("gam3ket") || normalized.includes("gamek3t")) {
      return loginFailureResponse(400, "This username is not allowed");
    }

    if (country.length > 100) {
      return loginFailureResponse(400, "Country name is too long");
    }

    // Check username uniqueness
    if (await users.findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } })) {
      return loginFailureResponse(400, "Username is already taken");
    }

    const userId = uuidv4();
    const registered = new Date().toISOString().split("T")[0];

    const user: User = {
      id: userId,
      username,
      email,
      country,
      isActive: true,
      isSuspended: false,
      isVerified: true,
      isPremium: false,
      rank: 1,
      registered,
      isStore: false,
      avatar: payload.picture || null,
    };

    const account: Account = {
      userId,
      email,
      password: null,
      authProvider: "google",
      twoFactorAuth: false,
      twoFactorSecret: null,
      twoFactorTempSecret: null,
      twoFactorEnabledAt: null,
      lastLogin: registered,
      tokenVersion: 1,
      otp: null,
      otpExpiresAt: null,
    };

    await users.insertOne(user);
    await accounts.insertOne(account);

    // Create wallet balance
    const walletsDb = getWalletsDB();
    await walletsDb.collection<Balance>("Balances").insertOne({
      userId,
      availableBalance: 0,
      suspendedBalance: 0,
      methods: [],
    });

    // Create store
    const catalogsDb = getCatalogsDB();
    await catalogsDb.collection<Store>("Stores").insertOne({
      userId,
      storeId: uuidv4(),
      storeName: username,
      isActive: true,
      isApproved: false,
      approveStatus: null,
      isPromoted: false,
      type: "basic",
      totalSales: 0,
      positiveReviews: 0,
      negativeReviews: 0,
      reviews: [],
      createdAt: registered,
      requestCount: 0,
    });

    const token = issueLoginToken(user, 1);

    return {
      code: 201,
      success: true,
      message: "Registration successful",
      token,
      user: { ...user, twoFactorAuth: false },
      requiresTwoFactor: false,
      twoFactorToken: null,
    };
  },

  verifyTwoFactorLogin: async (
    _: unknown,
    { input }: { input: { twoFactorToken: string; code: string } }
  ) => {
    const payload = decodeTwoFactorChallengeToken(input.twoFactorToken);
    if (!payload) {
      return loginFailureResponse(401, "Invalid or expired two-factor token");
    }

    const code = normalizeTwoFactorCode(input.code);
    if (!isValidTwoFactorCode(code)) {
      return loginFailureResponse(400, "Invalid two-factor code format");
    }

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const account = await accounts.findOne({ userId: payload.userId });
    const user = await users.findOne({ id: payload.userId });

    if (!account || !user) {
      return loginFailureResponse(401, "Invalid authentication flow");
    }

    if (!hasTwoFactorConfigured(account)) {
      return loginFailureResponse(400, "Two-factor authentication is not enabled for this account");
    }

    if ((account.tokenVersion ?? 0) !== payload.tokenVersion) {
      return loginFailureResponse(401, "Two-factor token is no longer valid. Please log in again");
    }

    let secret: string;
    try {
      secret = decryptTwoFactorSecret(account.twoFactorSecret!);
    } catch {
      return loginFailureResponse(500, "Two-factor configuration error");
    }

    const codeIsValid = verifySync({ token: code, secret }).valid;
    if (!codeIsValid) {
      return loginFailureResponse(401, "Invalid two-factor code");
    }

    const newTokenVersion = (account.tokenVersion ?? 0) + 1;
    await accounts.updateOne(
      { userId: payload.userId },
      { $set: { tokenVersion: newTokenVersion, lastLogin: new Date().toISOString() } }
    );

    const token = issueLoginToken(user, newTokenVersion);

    return {
      code: 200,
      success: true,
      message: "Login successful",
      token,
      user: { ...user, twoFactorAuth: true },
      requiresTwoFactor: false,
      twoFactorToken: null,
    };
  },

  beginTwoFactorSetup: async (
    _: unknown,
    __: unknown,
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const user = await users.findOne({ id: userId });
    const account = await accounts.findOne({ userId });
    if (!user || !account) {
      return { code: 404, success: false, message: "Account not found", setup: null };
    }

    if (hasTwoFactorConfigured(account)) {
      return { code: 400, success: false, message: "Two-factor authentication is already enabled", setup: null };
    }

    const manualEntryKey = generateSecret();
    const encryptedSecret = encryptTwoFactorSecret(manualEntryKey);

    await accounts.updateOne(
      { userId },
      { $set: { twoFactorTempSecret: encryptedSecret } }
    );

    const otpAuthUrl = generateURI({
      issuer: TWO_FACTOR_ISSUER,
      label: user.email,
      secret: manualEntryKey,
      strategy: "totp",
    });
    const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

    return {
      code: 200,
      success: true,
      message: "Two-factor setup started",
      setup: {
        otpAuthUrl,
        qrCodeDataUrl,
        manualEntryKey,
      },
    };
  },

  verifyTwoFactorSetup: async (
    _: unknown,
    { input }: { input: { code: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const user = await users.findOne({ id: userId });
    const account = await accounts.findOne({ userId });
    if (!account) {
      return { code: 404, success: false, message: "Account not found", user, twoFactorAuth: null };
    }

    if (!account.twoFactorTempSecret) {
      return {
        code: 400,
        success: false,
        message: "No pending two-factor setup found. Start setup first",
        user,
        twoFactorAuth: account.twoFactorAuth,
      };
    }

    const code = normalizeTwoFactorCode(input.code);
    if (!isValidTwoFactorCode(code)) {
      return { code: 400, success: false, message: "Invalid two-factor code format", user, twoFactorAuth: account.twoFactorAuth };
    }

    let secret: string;
    try {
      secret = decryptTwoFactorSecret(account.twoFactorTempSecret);
    } catch {
      return { code: 500, success: false, message: "Two-factor configuration error", user, twoFactorAuth: account.twoFactorAuth };
    }

    const codeIsValid = verifySync({ token: code, secret }).valid;
    if (!codeIsValid) {
      return { code: 400, success: false, message: "Invalid two-factor code", user, twoFactorAuth: account.twoFactorAuth };
    }

    await accounts.updateOne(
      { userId },
      {
        $set: {
          twoFactorAuth: true,
          twoFactorSecret: account.twoFactorTempSecret,
          twoFactorTempSecret: null,
          twoFactorEnabledAt: new Date().toISOString(),
        },
      }
    );

    return { code: 200, success: true, message: "Two-factor authentication enabled", user, twoFactorAuth: true };
  },

  disableTwoFactorAuth: async (
    _: unknown,
    { input }: { input: { code: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const user = await users.findOne({ id: userId });
    const account = await accounts.findOne({ userId });
    if (!account) {
      return { code: 404, success: false, message: "Account not found", user, twoFactorAuth: null };
    }

    if (!hasTwoFactorConfigured(account)) {
      return { code: 400, success: false, message: "Two-factor authentication is not enabled", user, twoFactorAuth: false };
    }

    const code = normalizeTwoFactorCode(input.code);
    if (!isValidTwoFactorCode(code)) {
      return { code: 400, success: false, message: "Invalid two-factor code format", user, twoFactorAuth: true };
    }

    let secret: string;
    try {
      secret = decryptTwoFactorSecret(account.twoFactorSecret!);
    } catch {
      return { code: 500, success: false, message: "Two-factor configuration error", user, twoFactorAuth: true };
    }

    const codeIsValid = verifySync({ token: code, secret }).valid;
    if (!codeIsValid) {
      return { code: 400, success: false, message: "Invalid two-factor code", user, twoFactorAuth: true };
    }

    await accounts.updateOne(
      { userId },
      {
        $set: {
          twoFactorAuth: false,
          twoFactorSecret: null,
          twoFactorTempSecret: null,
          twoFactorEnabledAt: null,
        },
      }
    );

    return { code: 200, success: true, message: "Two-factor authentication disabled", user, twoFactorAuth: false };
  },

  updatePassword: async (
    _: unknown,
    { input }: { input: { oldPassword: string; newPassword: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const { oldPassword, newPassword } = input;

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const user = await users.findOne({ id: userId });
    const account = await accounts.findOne({ userId });
    if (!account) {
      return { code: 404, success: false, message: "Account not found" };
    }

    if (account.authProvider === "google") {
      return { code: 400, success: false, message: "Cannot update password for Google accounts" };
    }

    // Verify old password matches current password
    const valid = await bcrypt.compare(oldPassword, account.password || "");
    if (!valid) {
      return { code: 401, success: false, message: "Current password is incorrect" };
    }

    // Validate new password
    if (newPassword.length < 8) {
      return { code: 400, success: false, message: "Password must be at least 8 characters" };
    }
    if (newPassword.length > 128) {
      return { code: 400, success: false, message: "Password must be at most 128 characters" };
    }
    if (!/[A-Z]/.test(newPassword)) {
      return { code: 400, success: false, message: "Password must contain at least one uppercase letter" };
    }
    if (!/[a-z]/.test(newPassword)) {
      return { code: 400, success: false, message: "Password must contain at least one lowercase letter" };
    }
    if (!/[0-9]/.test(newPassword)) {
      return { code: 400, success: false, message: "Password must contain at least one number" };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password and increment tokenVersion to force re-login
    const newTokenVersion = (account.tokenVersion ?? 0) + 1;

    await accounts.updateOne(
      { userId },
      { $set: { password: hashedPassword, tokenVersion: newTokenVersion } }
    );

    return { code: 200, success: true, message: "Password updated successfully. Please log in again.", user };
  },

  updateTwoFactorAuth: async (
    _: unknown,
    __: unknown,
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const user = await users.findOne({ id: userId });
    const account = await accounts.findOne({ userId });
    if (!account) {
      return { code: 404, success: false, message: "Account not found", twoFactorAuth: null };
    }

    if (hasTwoFactorConfigured(account)) {
      return {
        code: 400,
        success: false,
        message: "Use disableTwoFactorAuth(input: { code }) to disable two-factor authentication",
        user,
        twoFactorAuth: true,
      };
    }

    return {
      code: 400,
      success: false,
      message: "Use beginTwoFactorSetup and verifyTwoFactorSetup to enable two-factor authentication",
      user,
      twoFactorAuth: false,
    };
  },

  sendVerification: async (
    _: unknown,
    { input }: { input: { email: string } }
  ) => {
    const email = input.email.trim().toLowerCase();

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const account = await accounts.findOne({ email });
    if (!account) {
      // Return generic success to prevent email enumeration
      return { code: 200, success: true, message: "If the email exists, a verification code has been sent" };
    }

    const user = await users.findOne({ id: account.userId });
    if (user?.isVerified) {
      return { code: 400, success: false, message: "Account is already verified" };
    }

    // Check if an active OTP already exists
    if (account.otp && account.otpExpiresAt && new Date(account.otpExpiresAt) > new Date()) {
      return { code: 429, success: false, message: "A verification code has already been sent. Please wait until it expires before requesting a new one" };
    }

    // Generate 6-digit OTP
    const otp = String(randomInt(100000, 999999));
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await accounts.updateOne(
      { email },
      { $set: { otp, otpExpiresAt } }
    );

    return { code: 200, success: true, message: "If the email exists, a verification code has been sent" };
  },

  completeVerification: async (
    _: unknown,
    { input }: { input: { email: string; otp: string } }
  ) => {
    const email = input.email.trim().toLowerCase();
    const otp = input.otp.trim();

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const account = await accounts.findOne({ email });
    if (!account) {
      return { code: 400, success: false, message: "Invalid verification details" };
    }

    if (!account.otp || !account.otpExpiresAt) {
      return { code: 400, success: false, message: "No verification code was requested" };
    }

    if (new Date() > new Date(account.otpExpiresAt)) {
      // Clear expired OTP
      await accounts.updateOne(
        { email },
        { $set: { otp: null, otpExpiresAt: null } }
      );
      return { code: 400, success: false, message: "Verification code has expired" };
    }

    if (account.otp !== otp) {
      return { code: 400, success: false, message: "Invalid verification code" };
    }

    // Clear OTP and mark user as verified
    await accounts.updateOne(
      { email },
      { $set: { otp: null, otpExpiresAt: null } }
    );

    await users.updateOne(
      { id: account.userId },
      { $set: { isVerified: true } }
    );

    return { code: 200, success: true, message: "Account verified successfully" };
  },
};
