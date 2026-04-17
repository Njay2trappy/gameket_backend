import { v4 as uuidv4 } from "uuid";
import { randomInt } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { GraphQLError } from "graphql";
import { getDB, getWalletsDB, getCatalogsDB } from "../../db.js";
import type { User, Account, Balance, Store } from "../../types.js";
import type { Context } from "../../index.js";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
      return { code: 401, success: false, message: "Invalid email or password", token: null, user: null };
    }

    if (account.authProvider === "google") {
      return { code: 400, success: false, message: "This email is registered with Google. Please sign in with Google.", token: null, user: null };
    }

    const valid = await bcrypt.compare(password, account.password || "");
    if (!valid) {
      return { code: 401, success: false, message: "Invalid email or password", token: null, user: null };
    }

    const user = await users.findOne({ id: account.userId });
    if (!user) {
      return { code: 401, success: false, message: "Invalid email or password", token: null, user: null };
    }

    if (!user.isActive) {
      return { code: 403, success: false, message: "Account is deactivated", token: null, user: null };
    }

    // Increment tokenVersion to invalidate all previous sessions
    const newTokenVersion = (account.tokenVersion ?? 0) + 1;

    await accounts.updateOne(
      { userId: account.userId },
      { $set: { lastLogin: new Date().toISOString(), tokenVersion: newTokenVersion } }
    );

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("Server configuration error");
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, tokenVersion: newTokenVersion },
      secret,
      { expiresIn: "1h" }
    );

    return { code: 200, success: true, message: "Login successful", token, user: { ...user, twoFactorAuth: account.twoFactorAuth } };
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
      return { code: 401, success: false, message: "Invalid Google token", token: null, user: null };
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return { code: 401, success: false, message: "Invalid Google token", token: null, user: null };
    }

    const email = payload.email.toLowerCase();

    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    // Check if user already exists
    const existingAccount = await accounts.findOne({ email });
    if (existingAccount) {
      if (existingAccount.authProvider !== "google") {
        return { code: 400, success: false, message: "This email is registered with email/password. Please login with your password.", token: null, user: null };
      }

      const user = await users.findOne({ id: existingAccount.userId });
      if (!user) {
        return { code: 401, success: false, message: "Account not found", token: null, user: null };
      }

      if (!user.isActive) {
        return { code: 403, success: false, message: "Account is deactivated", token: null, user: null };
      }

      const newTokenVersion = (existingAccount.tokenVersion ?? 0) + 1;

      await accounts.updateOne(
        { userId: existingAccount.userId },
        { $set: { lastLogin: new Date().toISOString(), tokenVersion: newTokenVersion } }
      );

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error("Server configuration error");
      }

      const token = jwt.sign(
        { userId: user.id, email: user.email, tokenVersion: newTokenVersion },
        secret,
        { expiresIn: "1h" }
      );

      return { code: 200, success: true, message: "Login successful", token, user: { ...user, twoFactorAuth: existingAccount.twoFactorAuth } };
    }

    // New user — username & country required
    const username = input.username?.trim();
    const country = input.country?.trim();

    if (!username) {
      return { code: 400, success: false, message: "Username is required for new accounts", token: null, user: null };
    }
    if (!country) {
      return { code: 400, success: false, message: "Country is required for new accounts", token: null, user: null };
    }

    // Validate username
    if (username.length > 15) {
      return { code: 400, success: false, message: "Username must be at most 15 characters", token: null, user: null };
    }
    if (/\s/.test(username)) {
      return { code: 400, success: false, message: "Username must not contain spaces", token: null, user: null };
    }

    const normalized = username.toLowerCase().replace(/[^a-z]/g, "");
    if (normalized.includes("gameket") || normalized.includes("gamket") || normalized.includes("gamekets") || normalized.includes("gam3ket") || normalized.includes("gamek3t")) {
      return { code: 400, success: false, message: "This username is not allowed", token: null, user: null };
    }

    if (country.length > 100) {
      return { code: 400, success: false, message: "Country name is too long", token: null, user: null };
    }

    // Check username uniqueness
    if (await users.findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } })) {
      return { code: 400, success: false, message: "Username is already taken", token: null, user: null };
    }

    const userId = uuidv4();
    const registered = new Date().toISOString().split("T")[0];

    const user: User = {
      id: userId,
      username,
      email,
      country,
      isActive: true,
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

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("Server configuration error");
    }

    const token = jwt.sign(
      { userId, email, tokenVersion: 1 },
      secret,
      { expiresIn: "1h" }
    );

    return { code: 201, success: true, message: "Registration successful", token, user: { ...user, twoFactorAuth: false } };
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

    const newValue = !account.twoFactorAuth;

    await accounts.updateOne(
      { userId },
      { $set: { twoFactorAuth: newValue } }
    );

    const message = newValue
      ? "Two-factor authentication enabled"
      : "Two-factor authentication disabled";

    return { code: 200, success: true, message, user, twoFactorAuth: newValue };
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
