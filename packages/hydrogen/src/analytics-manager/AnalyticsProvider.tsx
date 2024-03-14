import { type ReactNode, useEffect, useState , useMemo, createContext, useContext, useRef } from "react";
import { type CartReturn } from "../cart/queries/cart-types";
import {
  AnalyticsView,
  type PageViewPayload,
  type ProductViewPayload,
  type CollectionViewPayload,
  type CartViewPayload,
  type CartUpdatePayload,
  type CustomEventPayload,
  type OtherData,
  type EventPayloads,
} from "./AnalyticsView";
import type {CurrencyCode, LanguageCode} from '@shopify/hydrogen-react/storefront-api-types';
import {AnalyticsEvent} from "./events";
import {ShopifyAnalytics} from "./ShopifyAnalytics";
import {CartAnalytics} from "./CartAnalytics";

export type ShopAnalytic = {
  [key: string]: unknown;
  shopId: string;
  acceptedLanguage: LanguageCode | undefined;
  currency: CurrencyCode;
  hydrogenSubchannelId: string | '0',
}

export type AnalyticsProviderProps = {
  /** React children to render. */
  children?: ReactNode;
  /** The cart or cart promise to track. */
  cart: Promise<CartReturn | null> | CartReturn | null;
  /** An optional function to set wether the user can be tracked. */
  canTrack?: () => boolean;

  /** The optional customer object to pass to events **/
  // TODO: Need to solve for this. Do we want to defer the customer in the root and pass it down?
  // or do it client-side but we don't support customer queries on the client.
  // customer?: Promise<CustomerReturn | null> | CustomerReturn | null;

  /** An optional custom payload to pass to all events. e.g language/locale/currency */
  customPayload?: Record<string, unknown>;

  /** Prevents analytics from being sent to Shopify's admin dashboards */
  disableShopifyAnalytics?: boolean;

  /** The shop/store config required to publish events **/
  shop: Promise<ShopAnalytic | null> | ShopAnalytic | null;
}

export type Carts = {
  cart: Awaited<AnalyticsProviderProps['cart']>;
  prevCart: Awaited<AnalyticsProviderProps['cart']>;
}

type AnalyticsContextValue = {
  canTrack: NonNullable<AnalyticsProviderProps['canTrack']>;
  cart: Awaited<AnalyticsProviderProps['cart']>;
  customPayload: AnalyticsProviderProps['customPayload'];
  prevCart: Awaited<AnalyticsProviderProps['cart']>;
  publish: typeof publish;
  setCarts: React.Dispatch<React.SetStateAction<Carts>>;
  shop: Awaited<AnalyticsProviderProps['shop']>;
  subscribe: typeof subscribe;
  register: (key: string) => {ready: () => void};
}

export const defaultAnalyticsContext: AnalyticsContextValue = {
  canTrack: () => false,
  cart: null,
  customPayload: {},
  prevCart: null,
  publish: () => {},
  setCarts: () => ({cart: null, prevCart: null}),
  shop: null,
  subscribe: () => {},
  register: () => ({ready: () => {}}),
};

const AnalyticsContext = createContext<AnalyticsContextValue>(
  defaultAnalyticsContext,
);

const subscribers = new Map<string, Map<string, (payload: EventPayloads) => void>>();
const registers: Record<string, boolean> = {};

function areRegistersReady() {
  let ready = true;
  Object.keys(registers).forEach((key) => {
    if(!registers[key]) {
      ready = false;
    }
  });
  return ready;
}

// Overload functions for each subscribe event
function subscribe(
  event: typeof AnalyticsEvent.PAGE_VIEWED,
  callback: (payload: PageViewPayload) => void
): void;

function subscribe(
  event: typeof AnalyticsEvent.PRODUCT_VIEWED,
  callback: (payload: ProductViewPayload) => void
): void;

function subscribe(
  event: typeof AnalyticsEvent.COLLECTION_VIEWED,
  callback: (payload: CollectionViewPayload) => void
): void;

function subscribe(
  event: typeof AnalyticsEvent.CART_VIEWED,
  callback: (payload: CartViewPayload) => void
): void;

function subscribe(
  event: typeof AnalyticsEvent.CART_UPDATED,
  callback: (payload: CartUpdatePayload) => void
): void;

function subscribe(
  event: typeof AnalyticsEvent.CUSTOM_EVENT,
  callback: (payload: CustomEventPayload) => void
): void;

function subscribe(
  event: any,
  callback: any
) {
  if (!subscribers.has(event)) {
    subscribers.set(event, new Map());
  }
  subscribers.get(event)?.set(callback.toString(), callback);
}

const waitForReadyQueue = new Map<any, any>();

function publish(event: typeof AnalyticsEvent.PAGE_VIEWED, payload: PageViewPayload): void;
function publish(event: typeof AnalyticsEvent.PRODUCT_VIEWED, payload: ProductViewPayload): void;
function publish(event: typeof AnalyticsEvent.COLLECTION_VIEWED, payload: CollectionViewPayload): void;
function publish(event: typeof AnalyticsEvent.CART_VIEWED, payload: CartViewPayload): void;
function publish(event: typeof AnalyticsEvent.CART_UPDATED, payload: CartUpdatePayload): void;
function publish(event: typeof AnalyticsEvent.CUSTOM_EVENT, payload: OtherData): void;
function publish(event: any,  payload: any): void {
  if (!areRegistersReady()) {
    waitForReadyQueue.set(event, payload);
    return;
  }
  publishEvent(event, payload);
}

function publishEvent(event:any, payload: any):void {
  (subscribers.get(event) ?? new Map()).forEach((callback) => {
    try {
      callback(payload);
    } catch (error) {
      if (typeof error === 'object' && error instanceof Error) {
        console.error('Analytics publish error', error.message);
      } else {
        console.error('Analytics publish error', error);
      }
    }
  });
}

function register(key: string) {
  if (!registers.hasOwnProperty(key)) {
    registers[key] = false;
  }

  return {
    ready: () => {
      registers[key] = true;

      if(areRegistersReady() && waitForReadyQueue.size > 0) {
        waitForReadyQueue.forEach((queuePayload, queueEvent) => {
          publishEvent(queueEvent, queuePayload);
        });
        waitForReadyQueue.clear();
    }
    }
  }
}

// This functions attempts to automatically determine if the user can be tracked if the
// customer privacy API is available. If not, it will default to false.
function shopifyCanTrack() {
  if (
    typeof window !== 'undefined' &&
    typeof window?.Shopify === 'object' &&
    typeof window?.Shopify?.customerPrivacy === 'object' &&
    typeof window?.Shopify?.customerPrivacy?.userCanBeTracked === 'function'
  ) {
    return window.Shopify.customerPrivacy.userCanBeTracked();
  }
  return false;
}

export function AnalyticsProvider({
  children,
  canTrack: customCanTrack,
  customPayload = {},
  cart: currentCart,
  shop: shopProp = null,
  disableShopifyAnalytics = false
}: AnalyticsProviderProps): JSX.Element {
  const listenerSet = useRef(false);
  const {shop} = useShopAnalytics(shopProp);
  const [consentLoaded, setConsentLoaded] = useState(customCanTrack ? true : false);
  const [carts, setCarts] = useState<Carts>({cart: null, prevCart: null});
  const [canTrack, setCanTrack] = useState(customCanTrack ? () => customCanTrack : () => shopifyCanTrack);

  useEffect(() => {
    if (customCanTrack) return;
    if (listenerSet.current) return;
    listenerSet.current = true;

    // Listen for the customerPrivacyApiLoaded event dispatched by the
    // useCustomerPrivacy hook
    document.addEventListener('customerPrivacyApiLoaded', (event) => {;
      if (!event.detail) {
        setConsentLoaded(false);
        setCanTrack(() => () => false);
      } else {
        setConsentLoaded(event.detail);
        setCanTrack(() => shopifyCanTrack);
      }
    })
  }, [setConsentLoaded, setCanTrack, customCanTrack]);

  const value = useMemo<AnalyticsContextValue>(() => ({
    canTrack,
    ...carts,
    customPayload,
    publish,
    setCarts,
    shop,
    subscribe,
    register,
  }), [setCarts, consentLoaded, canTrack, JSON.stringify(canTrack), carts.cart?.updatedAt, carts.prevCart, publish, subscribe, customPayload, shop, register]);

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
      {shop && <AnalyticsView type="page_viewed" />}
      {shop && currentCart && <CartAnalytics cart={currentCart} />}
      {shop && !disableShopifyAnalytics && <ShopifyAnalytics />}
    </AnalyticsContext.Provider>
  );
};

export function useAnalyticsProvider(): AnalyticsContextValue {
  const analyticsContext = useContext(AnalyticsContext);
  if (!analyticsContext) {
    throw new Error(`'useAnalyticsProvider()' must be a descendent of <AnalyticsProvider/>`);
  }
  return analyticsContext;
}

/**
 * A hook that resolves the shop analytics that could have been deferred
 * and returns the shop analytics.
 */
function useShopAnalytics(shopProp: AnalyticsProviderProps['shop']): {shop: ShopAnalytic | null} {
  const [shop, setShop] = useState<Awaited<AnalyticsProviderProps['shop']>>(null);

  // resolve the shop analytics that could have been deferred
  useEffect(() => {
    Promise.resolve(shopProp).then(setShop);
    return () => {};
  }, [setShop, shopProp]);

  return {shop};
}
