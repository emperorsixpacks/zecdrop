/// <reference types="vite/client" />

// Declared for src/lib/config.ts, the only module allowed to read import.meta.
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_ZEC_NETWORK?: string;
  readonly VITE_EXPLORER_TESTNET_TX_URL?: string;
  readonly VITE_EXPLORER_MAINNET_TX_URL?: string;
  readonly VITE_EXPLORER_TESTNET_ADDRESS_URL?: string;
  readonly VITE_EXPLORER_MAINNET_ADDRESS_URL?: string;
  readonly VITE_PUBLIC_RECEIPT_BASE_URL?: string;
  readonly VITE_PUBLIC_ONLY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
