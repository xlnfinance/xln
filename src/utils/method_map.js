module.exports = (i) => {
    const methodMap = [
        'placeholder',

        // consensus
        'propose', // same word used to propose smart updates
        'prevote',
        'precommit',

        // onchain transactions
        'batch', // all transactions are batched one by one

        // methods below are per-assets (ie should have setAsset directive beforehand)
        'disputeWith', // defines signed state (balance proof). Used only as last resort!
        'withdrawFrom', // mutual *instant* withdrawal proof. Used during normal cooperation.
        'depositTo', // send money to some channel or user

        // onchain exchange
        'createOrder',
        'cancelOrder',

        'createAsset',
        'createHub',

        'revealSecrets', // reveal secrets if partner has not acked our del settle
        'vote',

        // offchain inputs
        'auth', // any kind of offchain auth signatures between partners
        'tx', // propose array of tx to add to block
        'sync', // i want to sync since this prev_hash
        'chain', // return X blocks since given prev_hash

        'ack',
        'testnet',

        'JSON',

        'textMessage' // random message to notify
    ]

    if (typeof i === 'string') {
        i = i.trim()
        if (methodMap.indexOf(i) == -1) throw `No such method: "${i}"`
        return methodMap.indexOf(i)
    } else {
        return methodMap[i]
    }
}
