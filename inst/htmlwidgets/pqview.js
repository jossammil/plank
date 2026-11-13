HTMLWidgets.widget({
  name: 'pqview',
  type: 'output',
  factory: function (el) {
    return {
      renderValue: function (x) {
        PQView.mount(el, x);
      },
      // The grid watches its own size, so there is nothing to do here.
      resize: function () {}
    };
  }
});
