

class Channel {
  constructor () {

    this.state = {
      left: '1',
      right: '2',
      previousBlockHash: '0x0',
      previousStateHash: '0x0',
      blockNumber: 0,
      timestamp: 0,
      transitionNumber: 0,
      subchannels: [
        {
          chainId: 123,
          deltas: [
            {
              tokenId: 2,
              collateral: 20,
              ondelta: 10,
              offdelta: 10,
              leftCreditLimit: 20,
              rightCreditLimit: 40,
              leftAllowence: 0,
              rightAllowence: 0
            },
            {
              tokenId: 23,
              collateral: 0,
              ondelta: 2,
              offdelta: 123,
              leftCreditLimit: 123,
              rightCreditLimit: 34
            }
            
          ],
          cooperativeNonce: 2,
          disputeNonce: 123,
          
        }
      ],
      subcontracts: [
        {
          type: 'payment', 
          chainId: 123,
          tokenId: 2,

          amount: 123,
          hash: '0x00',
          revealedUntilBlock: 123
        }
      ]
    };
  }






  function buildProofs() {
    const state = this.state;
    const encodedProofBody = [];
    const proofhash = [];

    const subcontracts = [];
    const proofbody = [];
    const scProviderAddress = await scProvider.getAddress()

    const proofABI = Depository__factory.abi
    .find(entry => entry.name === "processBatch").inputs[0].components
    .find(entry => entry.name === "finalDisputeProof").components
    .find(entry => entry.name === "finalProofbody");

    const batchAbi = SubcontractProvider__factory.abi
    .find(entry => entry.name === "encodeBatch").inputs[0]
  

    // 1. fill with deltas

    for (let i = 0; i < state.subchannels.length; i++) {
      let subch = state.subchannels[i];
      proofbody[i] = {
        offdeltas: [],
        tokenIds: [],
        subcontracts: []
      }


      for (let j = 0; j < subch.deltas.length; j++) {
        let d = subch.deltas[j];
        proofbody[i].offdeltas.push(d.offdelta);
        proofbody[i].tokenIds.push(d.tokenId);
      }
    }

    for (let i = 0; i < state.subchannels.length; i++) {
      encodedProofBody[i] = coder.encode([proofABI], [proofbody[i]])

      fullProof[i] = [MessageType.DisputeProof, 
        ch_key, 
        ch[0].channel.cooperativeNonce, 
        state.subchannels[i].disputeNonce,
        keccak256(encodedProofBody)
      ]

      const encoded_msg = coder.encode(
        ['uint8', 'bytes', 'uint', 'uint', 'bytes32'],
        fullProof[i]
      );
      proofhash[i] = ethers.keccak256(encoded_msg);
      console.log('sign hash', proofhash[i])
      sigs[i] = await user1.signMessage(ethers.getBytes(proofhash[i]));
    }


    return {
      encodedProofBody,
      proofbody,
      proofhash,
      sigs      
    };
  }












  function deriveEntry(d, isLeft = true) {
    const delta = d.ondelta + d.offdelta
    const collateral = d.collateral
  
    // for left user
    // Defines how payment channels work, based on "insurance" and delta=(ondelta+offdelta)
    // There are 3 major scenarios of delta position
    // . is 0 point, | is delta, = is insured, - is uninsured
    // 4,6  .====--| (left user owns entire insurance, has 2 uninsured)
    // 4,2  .==|==   (left and right both have 2 insured)
    // 4,-2 |--.==== (right owns entire insurance, 2 in uninsured balance)
    // https://codepen.io/anon/pen/wjLGgR visual demo

  
    const o = {
      delta: delta,
      collateral: collateral, 

      inCollateral: delta > collateral ? 0 : delta > 0 ? collateral - delta : collateral,
      outCollateral: delta > collateral ? collateral : delta > 0 ? delta : 0,

      inOwnCredit: delta < 0 ? -delta : 0,
      outPeerCredit: delta > collateral ? delta - collateral : 0,
  
      inAllowence: d.rightAllowence,
      outAllowence: d.leftAllowence,
  
      totalCapacity: collateral + d.leftCreditLimit + d.rightCreditLimit ,
      
      ownCreditLimit: d.leftCreditLimit,
      peerCreditLimit: d.rightCreditLimit,
      
      inCapacity: 0,
      outCapacity: 0,
      
      inOwnCredit: 0,
      outOwnCredit: 0,

      inPeerCredit: 0,
      outPeerCredit: 0,

    }
  
    if (!isLeft) {
      [o.outCollateral, o.outPeerCredit, o.inCollateral, o.inOwnCredit] = [o.inCollateral, o.inOwnCredit, o.outCollateral, o.outPeerCredit];
    }
  
    o.outOwnCredit = o.ownCreditLimit - o.inOwnCredit
    o.inPeerCredit = o.peerCreditLimit - o.outPeerCredit

    o.inCapacity = o.inOwnCredit + o.inCollateral + o.inPeerCredit - o.inAllowence
    o.outCapacity = o.outPeerCredit + o.outCollateral + o.outOwnCredit - o.outAllowence
      
    return o
  }

















  function deriveEntry(d, isLeft = true) {
    const delta = d.ondelta + d.offdelta
    const collateral = d.collateral
  
    const o = {
      delta: delta,
      collateral: collateral, 
  
      inCollateral: delta > collateral ? 0 : delta > 0 ? collateral - delta : collateral,
      outCollateral: delta > collateral ? collateral : delta > 0 ? delta : 0,
  
      inOwnCredit: delta < 0 ? -delta : 0,
      outPeerCredit: delta > collateral ? delta - collateral : 0,
  
      inAllowence: d.rightAllowence,
      outAllowence: d.leftAllowence,
  
      totalCapacity: collateral + d.leftCreditLimit + d.rightCreditLimit,
      
      ownCreditLimit: d.leftCreditLimit,
      peerCreditLimit: d.rightCreditLimit,
      
      inCapacity: 0,
      outCapacity: 0,
      
      inOwnCredit: 0,
      outOwnCredit: 0,
  
      inPeerCredit: 0,
      outPeerCredit: 0,
    }
  
    if (!isLeft) {
      [o.outCollateral, o.outPeerCredit, o.inCollateral, o.inOwnCredit] = [o.inCollateral, o.inOwnCredit, o.outCollateral, o.outPeerCredit];
    }
  
    o.outOwnCredit = o.ownCreditLimit - o.inOwnCredit
    o.inPeerCredit = o.peerCreditLimit - o.outPeerCredit
  
    o.inCapacity = o.inOwnCredit + o.inCollateral + o.inPeerCredit - o.inAllowence
    o.outCapacity = o.outPeerCredit + o.outCollateral + o.outOwnCredit - o.outAllowence
  
    // ASCII visualization
    const totalWidth = o.totalCapacity
    const leftCreditWidth = Math.floor((o.ownCreditLimit / totalWidth) * 50)
    const collateralWidth = Math.floor((collateral / totalWidth) * 50)
    const rightCreditWidth = 50 - leftCreditWidth - collateralWidth
    
    const deltaPosition = Math.floor(((delta + o.ownCreditLimit) / totalWidth) * 50)
    
    let ascii = '['
    ascii += '-'.repeat(leftCreditWidth)
    ascii += '='.repeat(collateralWidth)
    ascii += '-'.repeat(rightCreditWidth)
    ascii += ']'
    
    ascii = ascii.substr(0, deltaPosition) + '|' + ascii.substr(deltaPosition + 1)
  
    console.log(ascii)
  
    return o
  }
  for (let i = -30; i < 30; i++) {
    deriveEntry({
      tokenId: 2,
      collateral: 20,
      ondelta: 10,
      offdelta: i,
      leftCreditLimit: 20,
      rightCreditLimit: 40,
      leftAllowence: 0,
      rightAllowence: 0
    })
  }

  
  
  
  
  
  
  
  
}
