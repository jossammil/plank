HTMLWidgets.widget({
  name: 'plank',
  type: 'output',
  factory: function (el) {
    return {
      renderValue: function (x) {
        Plank.mount(el, x);
      },
      // The grid watches its own size, so there is nothing to do here.
      resize: function () {}
    };
  }
});
