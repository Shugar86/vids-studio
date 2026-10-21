export function chromeStorage() {
  const data = {};
  return {local: {
    get: async key => ({[key]: structuredClone(data[key])}),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async key => { delete data[key]; },
  }};
}
