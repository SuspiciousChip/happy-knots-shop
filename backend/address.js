export const INDIAN_STATES_AND_UTS = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
  'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal'
];

export function parseAddress(body) {
  const fields = Object.fromEntries(['label', 'name', 'phone', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pincode']
    .map(key => [key, String(body[key] || '').trim()]));
  if (!fields.label || fields.label.length > 40 || !fields.name || fields.name.length > 120 ||
      !/^[+0-9 ()-]{7,25}$/.test(fields.phone) || !fields.address_line1 ||
      fields.address_line1.length > 120 || fields.address_line2.length > 120 ||
      fields.landmark.length > 120 || !fields.city || fields.city.length > 80 ||
      !INDIAN_STATES_AND_UTS.includes(fields.state) || !/^[1-9][0-9]{5}$/.test(fields.pincode)) return null;
  return fields;
}

export const isCompleteAddress = address => Boolean(address?.address_line1 && address.city &&
  INDIAN_STATES_AND_UTS.includes(address.state) && /^[1-9][0-9]{5}$/.test(address.pincode));

export const formatAddress = address => [address.address_line1, address.address_line2,
  address.landmark ? `Landmark: ${address.landmark}` : '',
  `${address.city}, ${address.state} – ${address.pincode}`].filter(Boolean).join('\n');
