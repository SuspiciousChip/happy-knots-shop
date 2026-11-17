(() => {
  const button = document.querySelector('#payTest');
  const message = document.querySelector('#paymentMessage');
  const form = document.querySelector('#paymentResult');
  if (!button || !form) return;
  let loading;
  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve();
    if (!loading) loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Razorpay checkout could not load. Please try again.'));
      document.head.append(script);
    });
    return loading;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    message.textContent = 'Opening Razorpay test checkout…';
    try {
      await loadCheckout();
      const checkout = new window.Razorpay({
        key: button.dataset.key,
        amount: Number(button.dataset.amount),
        currency: 'INR',
        name: 'The Happy Knots',
        description: 'Simulated test payment',
        order_id: button.dataset.orderId,
        handler(result) {
          for (const name of ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'])
            form.elements.namedItem(name).value = result[name] || '';
          form.submit();
        },
        modal: { ondismiss() { button.disabled = false; message.textContent = 'Test payment was closed. No shop order was created.'; } }
      });
      checkout.on('payment.failed', () => { button.disabled = false; message.textContent = 'Test payment failed. You can try again.'; });
      checkout.open();
    } catch (error) {
      button.disabled = false;
      loading = null;
      message.textContent = error.message;
    }
  });
})();
