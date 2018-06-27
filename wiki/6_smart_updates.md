# Smart updates

Fairlayer has no smart contracts, instead it has smart updates (also known as onchain governance). In this document we will show why onchain governance is inevitable anyway, and how it solves new functionality problem.

Let's figure out what are smart contracts and what problem they solve.

> A smart contract is a computer protocol intended to digitally facilitate, verify, or enforce the negotiation or performance of a contract. Smart contracts allow the performance of credible transactions without third parties. These transactions are trackable and irreversible.[1] Smart contracts were first proposed by Nick Szabo in 1994.[2]

This is what Wikipedia says about smart contracts. However, the contract is "A contract is a voluntary arrangement between two or more parties that is enforceable by law as a binding legal agreement" and smart contract doesn't necessarily has two or more parties, doesn't necessarily deals with money or even does anything at all.

Which leads to the fact that **smart contract is neither smart nor contract**.

So what it really is? It is a **deterministic sandboxed program** which is executed on all machines to achieve same state as everyone else's. Most likely it's a bytecode handled by a virtual machine such as the EVM. 

The EVM claims to be Turing complete, so you can code a lot more different scenarios than with bitcoin scripts for example (which is very limited in opcodes and tooling). The EVM is created in response to the fact that **you cannot add new functionality to bitcoin because there's no onchain governance or pretty much any governance at all. Design is "set in stone".**

With the EVM you was supposed to be able to run same node software forever, because all the new EVM bytecode programs can be run by it, be it news feed, voting platform, a game or anything. 

**It didn't come out this way.** Ethereum is being hardforked regularly, which diminishes the idea of the EVM and its set-in-stone design. Hardfork requires massive cooperation off-chain, requires "weak subjectivity" as they call it, and ends up with just installing whatever is being uploaded to this URL `https://github.com/ethereum/go-ethereum`.

**The EVM would be considered properly implemented and "real" if people downloaded geth in 2015 and never updated ever since**. As long as the system requires outside tweaks, new opcodes or new gas estimations (they had DoS-like bug due to gas calculations) - it is basically cheating and **same governance in disguise**.

On top of that the EVM itself is very hard to use, all high level languages are immature with bugs ranging from <a href="https://medium.com/@homakov/make-ethereum-blockchain-again-ef73c5b86582">trivial race conditions</a> to library method visibility (parity bugs) - something you just don't get in languages with proven track records, because that would be too easy to catch just by looked at the code. **That will/can be improved over time, but not any time soon**

# Amendments

Not long after that, people came to realization that maybe what we need is not a "Turing complete" VM that will never be updated and set in stone, **but a clear process to update the underlying platform, the blockchain itself** aka onchain governance.

This was proposed by Tezos, Dfinity and many others to come. Fairlayer also uses amendments.

Any user can propose a change in platform formatted as: description in text, code to execute (can be like `User.find(3).destroy()`) and GNU diff patch that's merged into everyones code.

After that there's a voting period for days/weeks when validators can place votes on this proposal (yes/no). When the time comes blockchain looks at approval rate, and if it's over `K.supermajority` the code is executed with `eval` and the patch is merged with `patch`. The node is reloaded, and now the functionality is provided natively.

Articles (by <a href="http://vitalik.ca/general/2017/12/17/voting.html">Vitalik</a>, <a href="https://medium.com/@Vlad_Zamfir/against-on-chain-governance-a4ceacd040ca">Vlad</a>) from eth against onchain governance should be taken with grain of salt, as they are obviously biased against amendments as it is a superior solution over smart contracts (at least for foreseeable future). They also pretend that Proof-of-Stake is the only consensus and way to do onchain governance, which is clearly not (Failsafe uses proof of identity).

Instead check out more <a href="https://medium.com/@FEhrsam/blockchain-governance-programming-our-future-c3bfe30f2d74">visionary post by Fred</a> who's not so invested in smart contracts.

# Pros of Amendments

* amendments cover 99% of blockchain usecases. Validators only merge common valid use cases, **but they will not merge one-off toys w/o value like cryptokitties**

* amendments are much easier to write as they are using long known language such as JS/Go/Ruby etc (whatever the node is written in)

* they are faster to execute (because there's no virtualization factor) - they are close to the metal and can be written even in assembler for bottle neck parts.

* they can use a wider range of tools, such as Graph DB, RDBMS and so on, when smart contracts are limited to key-value contract storage which struggle to support even basic things like many-to-many relationships, SQL JOIN searches and so on.

* easier to cooperate between different amendments: they all exist in same space (full node software) and can call each other directly, skipping the CALL and encoding stuff of eth contracts

* you can add functionality smart contracts are simply not capable off: delayed jobs, adjusting blocksize/tax/tx format dynamically etc. Eg with state channels: in eth you need to explicitly withdraw the money and spend extra onchain tx, in Failsafe it is a `delayed` record in database that acts as a `crontab` that automatically withdraws your money if no disputing delta proof has been shown by the counterparty.

* explicit gas estimation - each method can be priced manually with eg `takeTax(inputs * K.input_price)`, which is more lightweight than counting gas step by step in the EVM.

# Pros of Smart Contracts

* No need to get approval from validators for your "generic" use case. If your use case is very unique you still can code it and just submit for everyone to execute. 

* No need to wait for delay period as well - you just do contract creation, and it's ready to use

# Conclusion

In theory, using the VM for executing arbitrary programs supports just about any use case. In practice, however, as we've seen there are **very few use cases that people actually need** (absolute majority of contracts in eth are ERC 20 tokens - something amendments could add natively much more efficiently). 

**It's also true that we cannot foresee all the use cases right now**, so that's why complete set-in-stone of Bitcoin has let us down over time - looking at Lightning Network you can see **a terrible complexity** for something that could just be added natively to the blockchain itself (in Failsafe the 2nd and 1st layer are tailored to each other)

Amendments provide us with right trade-off between usability, flexibility and decentralization. Self amendable blockchains will lead the competition for next decade, simply because there's not enough engineering power behind virtualized contracts.

If we see **ethereum not breaking consensus (hard forking) for 5 years in a row only then** we can claim smart contracts as a successfully implemented idea (given they also fix the tooling and make it easier to write code for the EVM).

Amendments are great for short-term (<10 years) and smart contracts can flourish in 10+ years at best. The coolest thing about amendments though is that a winning "smart contracts system" can simply be added via an amendment eventually. So we aim to be a Shang Tsung of blockchains, a shapeshifter who takes the best from others.

Smart contracts are good for showcasing and as a playground for things like Cryptokitties, but for production usage people would eventually take a successful smart contract use case and implement it natively into an amendment.

# [Home](/wiki/start.md)
