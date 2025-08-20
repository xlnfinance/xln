// Signer Service - Manages available signers for entity creation
// Provides dynamic signer discovery and management

import { writable, derived } from 'svelte/store';

// Types for signer management
export interface SignerInfo {
  id: string;
  name: string;
  displayName: string;
  avatar: string;
  isAvailable: boolean;
  lastSeen: number;
}

// Available signers (in a real system, these would be discovered dynamically)
const AVAILABLE_SIGNERS: SignerInfo[] = [
  {
    id: 'alice',
    name: 'alice',
    displayName: 'alice.eth',
    avatar: '👩‍💼',
    isAvailable: true,
    lastSeen: Date.now()
  },
  {
    id: 'bob',
    name: 'bob',
    displayName: 'bob.eth',
    avatar: '👨‍💻',
    isAvailable: true,
    lastSeen: Date.now()
  },
  {
    id: 'carol',
    name: 'carol',
    displayName: 'carol.eth',
    avatar: '👩‍🔬',
    isAvailable: true,
    lastSeen: Date.now()
  },
  {
    id: 'david',
    name: 'david',
    displayName: 'david.eth',
    avatar: '👨‍🎨',
    isAvailable: true,
    lastSeen: Date.now()
  },
  {
    id: 'eve',
    name: 'eve',
    displayName: 'eve.eth',
    avatar: '👩‍🚀',
    isAvailable: true,
    lastSeen: Date.now()
  }
];

// Stores
export const signers = writable<Map<string, SignerInfo>>(new Map());
export const availableSigners = derived(
  signers,
  ($signers) => Array.from($signers.values()).filter(s => s.isAvailable)
);

// Signer Service Implementation
class SignerServiceImpl {
  async initialize() {
    // Initialize with available signers
    const signerMap = new Map<string, SignerInfo>();
    for (const signer of AVAILABLE_SIGNERS) {
      signerMap.set(signer.id, signer);
    }
    signers.set(signerMap);
    
    console.log('👥 Signer service initialized with', signerMap.size, 'signers');
  }

  async getAvailableSigners(): Promise<SignerInfo[]> {
    const $signers = Array.from(signers.get().values());
    return $signers.filter(s => s.isAvailable);
  }

  async getSignerById(id: string): Promise<SignerInfo | null> {
    const $signers = signers.get();
    return $signers.get(id) || null;
  }

  async updateSignerAvailability(id: string, isAvailable: boolean) {
    const $signers = signers.get();
    const signer = $signers.get(id);
    if (signer) {
      signer.isAvailable = isAvailable;
      signer.lastSeen = Date.now();
      $signers.set(id, signer);
      signers.set($signers);
    }
  }

  async addCustomSigner(name: string, displayName?: string): Promise<SignerInfo> {
    const $signers = signers.get();
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const newSigner: SignerInfo = {
      id,
      name,
      displayName: displayName || `${name}.eth`,
      avatar: '👤',
      isAvailable: true,
      lastSeen: Date.now()
    };
    
    $signers.set(id, newSigner);
    signers.set($signers);
    
    console.log('✅ Added custom signer:', newSigner);
    return newSigner;
  }

  async removeSigner(id: string): Promise<boolean> {
    const $signers = signers.get();
    if ($signers.has(id)) {
      $signers.delete(id);
      signers.set($signers);
      console.log('🗑️ Removed signer:', id);
      return true;
    }
    return false;
  }

  // Utility methods
  formatSignerDisplay(signer: SignerInfo): string {
    return `${signer.avatar} ${signer.displayName}`;
  }

  generateSignerAvatar(signerId: string): string {
    // Generate deterministic avatar based on signer ID
    const avatars = ['👩‍💼', '👨‍💻', '👩‍🔬', '👨‍🎨', '👩‍🚀', '👨‍⚕️', '👩‍🏫', '👨‍🔧'];
    const index = signerId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % avatars.length;
    return avatars[index];
  }
}

// Export singleton instance
export const signerService = new SignerServiceImpl();

// Export utility functions
export function formatSignerName(signerId: string): string {
  return signerId.includes('.eth') ? signerId : `${signerId}.eth`;
}

export function getSignerAvatar(signerId: string): string {
  return signerService.generateSignerAvatar(signerId);
}
