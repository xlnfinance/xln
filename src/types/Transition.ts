export enum TransitionMethod {
  TextMessage,
  AddSubchannel,
  RemoveSubchannel,
  AddDelta,
  RemoveDelta,
  DirectPayment,
  ProposedEvent,
  SetCreditLimit,
  AddPaymentSubcontract,
  UpdatePaymentSubcontract,
  AddSwapSubcontract,
  RemoveSwapSubcontract,
}

// Define interfaces for each transition type
interface TextMessageTransitionData {
  message: string;
}

interface PaymentTransitionData {
  amount: number;
  tokenId: number;
}

interface AddSubchannelTransitionData {
  chainId: number;
}

// Define a mapping between string literals and TransitionMethod
const TransitionMethodMap = {
  'textMessage': TransitionMethod.TextMessage,
  'directPayment': TransitionMethod.DirectPayment,
  'addSubchannel': TransitionMethod.AddSubchannel,
  // Add other mappings here
} as const;

type TransitionMethodKeys = keyof typeof TransitionMethodMap;

// Define a type that maps TransitionMethod to its corresponding data type
type TransitionDataMap = {
  [K in TransitionMethodKeys]: K extends 'textMessage' ? TextMessageTransitionData :
                               K extends 'directPayment' ? PaymentTransitionData :
                               K extends 'addSubchannel' ? AddSubchannelTransitionData :
                               never;
}

// Type to check if all TransitionMethod enum values are accounted for
type EnsureAllMethodsCovered = {
  [K in TransitionMethod]: K extends (typeof TransitionMethodMap)[TransitionMethodKeys] ? true : never
}[TransitionMethod];

// This will cause a compile-time error if any TransitionMethod is not covered
type _ensureAllMethodsCovered = EnsureAllMethodsCovered extends true ? true : never;

// Main Transition class
export default class Transition<T extends TransitionMethodKeys> {
  readonly method: (typeof TransitionMethodMap)[T];

  constructor(method: T, data: TransitionDataMap[T]) {
    this.method = TransitionMethodMap[method];
    Object.assign(this, data);
  }
}

// Infer the correct return type for createTransition
type InferTransitionType<T extends TransitionMethodKeys> = Transition<T> & TransitionDataMap[T];

// Type-safe creation function
export function createTransition<T extends TransitionMethodKeys>(
  method: T,
  data: TransitionDataMap[T]
): InferTransitionType<T> {
  return new Transition(method, data) as InferTransitionType<T>;
}



export type AnyTransition = Transition<TransitionMethodKeys>;



/*
// Usage examples
const textTransition = createTransition('textMessage', { message: "Hello" });
console.log(textTransition.message); // Directly access 'message'

const paymentTransition = createTransition('directPayment', { amount: 100, tokenId: 1 });
console.log(paymentTransition.amount); // Directly access 'amount'
console.log(paymentTransition.amount); // Directly access 'tokenId'

const subchannelTransition = createTransition('addSubchannel', { chainId: 1 });
console.log(subchannelTransition.chainId); // Directly access 'chainId'

// These would cause TypeScript errors:
// const invalidTransition = createTransition('directPayment', { amount: "100" });
// const missingTransition = createTransition('removeSubchannel', {});
*/