(() => {
  const button = document.querySelector('#payOnline');
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
      script.onerror = () => reject(new Error('Razorpay could not load. Check your connection and try again.'));
      document.head.append(script);
    });
    return loading;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    message.textContent = 'Opening secure Razorpay checkout…';
    try {
      await loadCheckout();
      const checkout = new window.Razorpay({
        key: button.dataset.key,
        amount: Number(button.dataset.amount),
        currency: 'INR',
        name: 'Happy Knots',
        description: 'Handmade crochet order',
        order_id: button.dataset.orderId,
        prefill: { name: button.dataset.name, email: button.dataset.email, contact: button.dataset.contact },
        theme: { color: '#173f35' },
        handler(result) {
          message.textContent = 'Confirming your payment…';
          for (const name of ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'])
            form.elements.namedItem(name).value = result[name] || '';
          form.submit();
        },
        modal: { ondismiss() { button.disabled = false; message.textContent = 'Payment window closed. You can safely try again; no duplicate order will be created.'; } }
      });
      checkout.on('payment.failed', response => {
        button.disabled = false;
        message.textContent = response?.error?.description || 'Payment failed. No order was placed; you can try again.';
      });
      checkout.open();
    } catch (error) {
      button.disabled = false;
      loading = null;
      message.textContent = error.message;
    }
  });
})();
