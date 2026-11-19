document.querySelectorAll('#delivery-phone, .delivery-phone').forEach(phone => {
  const error = document.querySelector('#phone-error');
  const validatePhone = () => {
    const value = phone.value.trim();
    const message = !value ? 'Enter your 10-digit mobile number.'
      : /[^0-9]/.test(value) ? 'Use digits only; +91 is already included.'
      : value.length < 10 ? 'Phone number is too short. Enter 10 digits.'
      : value.length > 10 ? 'Phone number is too long. Enter 10 digits.' : '';
    phone.setCustomValidity(message);
    error.textContent = message;
  };
  phone.addEventListener('input', validatePhone);
  phone.addEventListener('blur', validatePhone);
  phone.addEventListener('invalid', validatePhone);
});
