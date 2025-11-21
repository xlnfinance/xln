
export const SubcontractBatchABI = {
        "components": [
          {
            "components": [
              {
                "internalType": "uint256",
                "name": "deltaIndex",
                "type": "uint256"
              },
              {
                "internalType": "int256",
                "name": "amount",
                "type": "int256"
              },
              {
                "internalType": "uint256",
                "name": "revealedUntilBlock",
                "type": "uint256"
              },
              {
                "internalType": "bytes32",
                "name": "hash",
                "type": "bytes32"
              }
            ],
            "internalType": "struct SubcontractProvider.Payment[]",
            "name": "payment",
            "type": "tuple[]"
          },
          {
            "components": [
              {
                "internalType": "bool",
                "name": "ownerIsLeft",
                "type": "bool"
              },
              {
                "internalType": "uint256",
                "name": "addDeltaIndex",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "addAmount",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "subDeltaIndex",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "subAmount",
                "type": "uint256"
              }
            ],
            "internalType": "struct SubcontractProvider.Swap[]",
            "name": "swap",
            "type": "tuple[]"
          }
        ],
        "internalType": "struct SubcontractProvider.Batch",
        "name": "b",
        "type": "tuple"
      }
    

export const ProofbodyABI = {
"components": [
    {
    "internalType": "int256[]",
    "name": "offdeltas",
    "type": "int256[]"
    },
    {
    "internalType": "uint256[]",
    "name": "tokenIds",
    "type": "uint256[]"
    },
    {
    "components": [
        {
        "internalType": "address",
        "name": "subcontractProviderAddress",
        "type": "address"
        },
        {
        "internalType": "bytes",
        "name": "encodedBatch",
        "type": "bytes"
        },
        {
        "components": [
            {
            "internalType": "uint256",
            "name": "deltaIndex",
            "type": "uint256"
            },
            {
            "internalType": "uint256",
            "name": "rightAllowence",
            "type": "uint256"
            },
            {
            "internalType": "uint256",
            "name": "leftAllowence",
            "type": "uint256"
            }
        ],
        "internalType": "struct Depository.Allowence[]",
        "name": "allowences",
        "type": "tuple[]"
        }
    ],
    "internalType": "struct Depository.SubcontractClause[]",
    "name": "subcontracts",
    "type": "tuple[]"
    }
],
"internalType": "struct Depository.ProofBody",
"name": "finalProofbody",
"type": "tuple"
}

