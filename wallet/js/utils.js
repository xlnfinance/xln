// DOM manipulation short cuts

function $ (id) {
  return document.querySelector(id)
}

function $$ (id) {
  return document.querySelectorAll(id)
}

function hide (el) {
  if (typeof el === 'string') el = $(el)
  el.style.display = 'none'
}

function show (el) {
  if (typeof el === 'string') el = $(el)
  el.style.display = 'block'
}

timestamp = () => {
  return Math.floor(new Date() / 1000)
}

screen = function (label) {
  // show($('.container'))
  var conts = $$('.screen')
  for (var i = 0; i < conts.length; i++) {
    if (conts[i].classList.contains(label)) {
      show(conts[i])
    } else {
      hide(conts[i])
    }
  }
}

logout = function () {
  if (confirm('You will not lose any data, but you will have to enter same email & password to log in this profile again')) {
    localStorage.clear()
    location.hash = ''
    location.reload()
  }
}

// escape HTML entities

var entityMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
  '/': '&#x2F;'
}

e = function (string) {
  return String(string).replace(/[&<>"'/]/g, function (s) {
    return entityMap[s]
  })
}
