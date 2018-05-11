<template>

<article>
  <section id="intro">
    <div class="intro-header">
      <h1>Fairlayer: Double-Layered Payment Network</h1>
    </div>
  </section>

  <section id="services">
    <div class="content-section-a">
      <div class="container">
        <div class="row">
          <div>
     
            <hr class="section-heading-spacer">
                      
            <p>
            <a href="https://github.com/failsafenetwork/failsafe"><img style="width:32px" src="../img/github.svg"></a> 
            &nbsp;<a href="https://medium.com/failsafe"><img style="width:32px" src="../img/medium.svg"></a> 
            &nbsp;<a href="https://twitter.com/failsafedollar"><img style="width:32px" src="../img/twitter.svg"></a>
            &nbsp;<a href="https://www.reddit.com/r/failsafenetwork/"><img style="width:32px" src="../img/reddit.svg"></a> 
            </p>

            <p>All "scalable" blockchains up until now were simply about increasing blocksize or obfuscating the way transactions are ordered and confirmed. It destroys the underlying security principles of blockchain and its decentralization for the sake of a temporary capacity relief.</p>

            <p>Failsafe is the first blockchain ever to go entirely "offchain" out of box: where each participant routinely remains a fully-verifying node with no dependance on Simple Payment Verification / light-clients.</p>

            <p>More than that, when <b>bloatchains</b> claim something like 100,000 tps under ridiculous testing conditions (few heavily centralized datacenters interconnected with Gigabit link) Failsafe can <b>routinely support millions of tps and scale pretty much infinitely</b>. Our goal is to never compromise on safety and correctness of the first settlement layer and <b>have all laptops and mobile phones as full nodes</b>.</p>

            <p><strong>Superset of Lightning Network</strong>. In a way, Failsafe is just an extended version of LN. We've fixed <a href="http://lightning.network/">Lightning's</a> capacity/liquidity issues with uninsured balances, and implemented offchain functionality natively in the blockchain itself, instead of running it on top of a virtual machine opcodes. This dramatically reduces the complexity of payment channels and our codebase is easier to audit and maintain -  20k lines of code (Bitcoin Core 100k + LND 100k, Parity 150k + Raiden 48k).</p>

            <p><strong>Everyone is a Full Node</strong>. Our verifying full-node <b>is built to routinely run on consumer hardware: laptops and mobile phones</b> without any inconvenience for the end user. The node is restricted at 1 Gb of disk space and 50 Mb of data to download per day. The node processes very few rebalancing transactions which doesn't require significant resources unlike full nodes of other blockchains.</p>

            <p><strong>Built to Scale</strong>. Failsafe hubs process transactions independently from each other and only share common settlement layer: <b>the system has nearly no scalability limit</b>: 1M transactions per second offchain require just a few rebalance transactions onchain. Payments are instant and do not require onchain confirmations. Onchain capacity no more dictates capacity of payments, but only impacts <b>average uninsured balances</b>. Uninsured money can be lost if the hub becomes insolvent, but it is a tiny part of all money in the system that helps it scale.</p>

            <p><strong>Byzantine Fault Tolerant</strong>. Our consensus of choice is Tendermint with identities-based Proof-of-Stake. Shares are distributed to public identities 1-for-1 which provides <b>highest Byzantine tolerance</b> (also known as <a href="https://news.earn.com/quantifying-decentralization-e39db233c28e">Nakomoto coefficient</a>). It takes to compromise 34 entities to hijack this blockchain vs just 3 mining pools in Bitcoin or Ethereum.</p>

            <p><a href="https://medium.com/failsafe">To learn details visit our blog</a></p>

          </div>
        </div>
      </div>
    </div>
  </section>
</article>

</template>
