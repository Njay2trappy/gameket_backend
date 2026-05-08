import crypto from "crypto";
import type { Product, Store } from "../types.js";

export type ApiOrderCallbackPayload = {
  orderId: string;
  productId: string;
  storeId: string;
  quantity: number;
  amount: number;
  fee: number;
  totalAmount: number;
  datainput?: string | null;
  requestedAt: string;
  source: "user" | "guest";
};

export type ApiOrderCallbackResult = {
  success: boolean;
  status: number | null;
  error: string | null;
};

// Sellers should validate callback timestamps within this window.
const CALLBACK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60 * 60;

const hmacSha256Hex = (secret: string, payload: string): string => {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
};

export const isApiFulfillmentProduct = (product: Product): boolean => {
  return Boolean(product.isAPI);
};

export const resolveApiCallbackUrl = (product: Product): string | null => {
  const raw = typeof product.apiCallbackUrl === "string" ? product.apiCallbackUrl.trim() : "";
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

export const dispatchApiOrderCallback = async (
  product: Product,
  store: Store,
  payload: ApiOrderCallbackPayload
): Promise<ApiOrderCallbackResult> => {
  const callbackUrl = resolveApiCallbackUrl(product);
  if (!callbackUrl) {
    return {
      success: false,
      status: null,
      error: "API callback URL is missing or invalid for this product",
    };
  }

  const body = {
    orderId: payload.orderId,
    productId: payload.productId,
    productName: product.name,
    productType: product.type,
    storeId: payload.storeId,
    storeName: store.storeName,
    quantity: payload.quantity,
    amount: payload.amount,
    fee: payload.fee,
    totalAmount: payload.totalAmount,
    datainput: payload.datainput ?? null,
    requestedAt: payload.requestedAt,
    source: payload.source,
  };

  const bodyString = JSON.stringify(body);

  const secret = typeof store.merchantSecret === "string" ? store.merchantSecret.trim() : "";
  if (!secret) {
    return {
      success: false,
      status: null,
      error: "Merchant secret is missing for this store",
    };
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = `${timestamp}.${bodyString}`;
  const signature = hmacSha256Hex(secret, signaturePayload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-gk-signature": `t=${timestamp},v1=${signature},w=${CALLBACK_SIGNATURE_TOLERANCE_SECONDS}`,
  };

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body: bodyString,
    });

    if (!response.ok) {
      let error = `HTTP ${response.status}`;
      try {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.toLowerCase().includes("application/json")) {
          const json = await response.json();
          error = typeof json?.message === "string" ? json.message : JSON.stringify(json);
        } else {
          const text = await response.text();
          if (text.trim()) error = text.trim();
        }
      } catch {
        // Ignore parse errors and keep fallback error value.
      }

      return {
        success: false,
        status: response.status,
        error,
      };
    }

    return {
      success: true,
      status: response.status,
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      status: null,
      error: error instanceof Error ? error.message : "Failed to reach API callback URL",
    };
  }
};
