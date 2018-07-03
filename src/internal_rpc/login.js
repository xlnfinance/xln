module.exports = (ws, proxyOrigin) => {
  // Successor of Secure Login, returns signed origin
  ws.send(
    JSON.stringify({
      result: toHex(nacl.sign(Buffer.from(proxyOrigin), me.id.secretKey))
    })
  )
}
