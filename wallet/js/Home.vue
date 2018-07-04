<template>

<article>
  <section id="intro">
    <div class="intro-header">
      <h1>Fairlayer: Two-Layered Payment Network</h1>
    </div>
  </section>

  <section id="services">
    <div class="content-section-a">
      <div class="container">
        <div class="row">
          <div>
     
            <hr class="section-heading-spacer">
                      
            <p>
            <a href="https://github.com/fairlayer/fair"><img style="width:32px" src="../img/github.svg"></a> 
            &nbsp;<a href="https://medium.com/fairlayer"><img style="width:32px" src="../img/medium.svg"></a> 
            &nbsp;<a href="https://twitter.com/fairlayer_com"><img style="width:32px" src="../img/twitter.svg"></a>
            &nbsp;<a href="https://www.reddit.com/r/fairlayer/"><img style="width:32px" src="../img/reddit.svg"></a> 
            </p>

            <p>Fairlayer is a decentralized payment network that takes asset stability and instant transfers of traditional finance and adds security of the blockchain.</p>

            <p>It is composed of two loosely coupled layers: globally shared "onchain" state and node-to-node "offchain" protocol. It repurposes the blockchain's slow replicated state to work as insurance layer and crypto court for disputes, moving all payments to be processed instantly and cheaply through non-custodial hubs.</p>

            <p><b>Balance of scalability and decentralization.</b> Fairlayer can support billion+ transactions per second and scale to all world value transfers, while having all laptops and mobile phones as full nodes.</p>

            <p><strong>Extended Lightning Network</strong>. Fairlayer implements XLN scaling concept - we've fixed <a href="https://medium.com/fairlayer/xln-extended-lightning-network-80fa7acf80f3">original Lightning's capacity/liquidity issues with uninsured balances</a>. Also, we implemented payment channel functionality natively in the blockchain itself, instead of running it on top of a virtual machine opcodes. This dramatically reduces the complexity of payment channels and makes the codebase easier to audit and maintain.</p>

            <p><strong>Everyone is a Full Node</strong> is our #1 security principle. Full nodes of most blockchains become unusable on consumer devices when they get popular, that's why everyone moves to insecure light clients. That will never happen to Fairlayer - our full node is built to routinely run on consumer hardware - laptops and mobile phones - no matter how many people are using it, 1 million or 10 billions. The wallet processes very few insurance rebalances and requires negligible resources and bandwidth.</p>

            <p><strong>Focused on stable assets</strong>. Knowing how hard it is for real world businesses to accept volatile assets such as Bitcoin, our primary focus is supporting stable coins and fiat tokens. The network comes with Fair Dollar as a native currency issued by Fair Foundation, but anyone else can create their own asset on top of it.</p>

          </div>
        </div>
      </div>
    </div>
  </section>
</article>

</template>
