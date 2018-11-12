window.tour = new Tour.Tour({
  defaultStepOptions: {
    classes: 'shadow-md bg-purple-dark',
    scrollTo: true
  }
})

tour.addStep('login-step', {
  text: 'We prefilled demo credentials for you, but you can choose your own.',
  attachTo: '.step-login bottom',
  classes: 'example-step-extra-class',
  buttons: [
    {
      text: 'Next',
      action: tour.next
    }
  ]
})

tour.addStep('layer-faucet', {
  text: 'Get funds on your onchain balance.',
  attachTo: '.layer-faucet bottom',
  classes: 'example-step-extra-class',
  buttons: [
    {
      text: 'Next',
      action: tour.next
    }
  ]
})

//tour.show('login-step')

//tour.start()
