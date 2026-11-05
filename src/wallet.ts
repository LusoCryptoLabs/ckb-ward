// What a wallet or a site needs to make and read a proof: the message and the template. No Node
// built-ins and no verifier, so it bundles for a browser (`ckb-ward/wallet`).
export { MAX_MESSAGE_BYTES, message, parseMessage, type MessageFields, type MessageInput } from "./message.ts";
export { NULL_LOCK, PROOF_INDEX, PROOF_INPUT_CAPACITY, PROOF_TAG, proofOutPoint, proofTemplate, readProof } from "./template.ts";
